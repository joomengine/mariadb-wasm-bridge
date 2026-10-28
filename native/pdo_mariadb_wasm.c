/* SPDX-License-Identifier: Apache-2.0
 * PDO MySQL transport for the JoomEngine MariaDB WASM bridge, protocol v1.
 * Compile into PHP or load as a matching WASM extension, without native pdo_mysql.
 */
#ifdef HAVE_CONFIG_H
# include "config.h"
#endif
#include "php.h"
#include "php_pdo_mariadb_wasm.h"
#include "ext/pdo/php_pdo_driver.h"
#include "ext/json/php_json.h"
#include "ext/standard/base64.h"
#include "ext/standard/info.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "Zend/zend_strtod.h"
#include <limits.h>
#include <math.h>

#define WM_VERSION "0.1.0"

typedef struct {
    zend_string *connection;
    zend_string *server_version;
    zend_string *insert_id;
    zend_string *error_message;
    zend_long error_number;
    bool in_transaction;
} wm_db;

typedef struct {
    zval result;
    zend_long row;
    zend_string *error_message;
    zend_long error_number;
} wm_stmt;

static const struct pdo_dbh_methods wm_db_methods;
static const struct pdo_stmt_methods wm_stmt_methods;

static zval *wm_field(zval *object, const char *name)
{
    return Z_TYPE_P(object) == IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(object), name, strlen(name)) : NULL;
}

static bool wm_string(zval *value)
{
    return value && Z_TYPE_P(value) == IS_STRING;
}

static bool wm_error(pdo_dbh_t *dbh, pdo_stmt_t *stmt, const char *state, zend_long number, const char *message)
{
    wm_db *db = dbh->driver_data;
    wm_stmt *statement = stmt ? stmt->driver_data : NULL;
    zend_string **stored = statement ? &statement->error_message : &db->error_message;
    zend_long *stored_number = statement ? &statement->error_number : &db->error_number;
    if (*stored) zend_string_release(*stored);
    *stored = zend_string_init(message, strlen(message), false);
    *stored_number = number;
    memcpy(stmt ? stmt->error_code : dbh->error_code, state, 6);
    return false;
}

static bool wm_protocol_error(pdo_dbh_t *dbh, pdo_stmt_t *stmt)
{
    return wm_error(dbh, stmt, "HY000", 0, "Malformed mariadb.v1 host response");
}

/* Non-negative decimal strings are used on the wire, including on wasm32. */
static bool wm_decimal(zval *value)
{
    if (!wm_string(value) || Z_STRLEN_P(value) == 0) return false;
    for (size_t i = 0; i < Z_STRLEN_P(value); i++) {
        if (Z_STRVAL_P(value)[i] < '0' || Z_STRVAL_P(value)[i] > '9') return false;
    }
    return true;
}

static bool wm_count(zval *value, zend_long *count)
{
    if (!wm_decimal(value)) return false;
    zend_ulong number = 0;
    for (size_t i = 0; i < Z_STRLEN_P(value); i++) {
        unsigned digit = (unsigned) (Z_STRVAL_P(value)[i] - '0');
        if (number > ((zend_ulong) ZEND_LONG_MAX - digit) / 10) return false;
        number = number * 10 + digit;
    }
    *count = (zend_long) number;
    return true;
}

/* MySQL integer field types: TINY, SHORT, LONG, LONGLONG, INT24 and YEAR. */
static bool wm_integer_type(zend_long type)
{
    return type == 1 || type == 2 || type == 3 || type == 8 || type == 9 || type == 13;
}

/* Parse within this PHP build's signed integer range, including ZEND_LONG_MIN.
 * Out-of-range integers remain exact strings, especially on wasm32 builds.
 */
static bool wm_integer(zend_string *text, zend_long *value)
{
    size_t length = ZSTR_LEN(text), index = 0;
    if (!length) return false;
    bool negative = ZSTR_VAL(text)[0] == '-';
    if (negative && ++index == length) return false;
    zend_ulong limit = (zend_ulong) ZEND_LONG_MAX + (negative ? 1 : 0);
    zend_ulong number = 0;
    for (; index < length; index++) {
        unsigned char character = (unsigned char) ZSTR_VAL(text)[index];
        if (character < '0' || character > '9') return false;
        unsigned digit = character - '0';
        if (number > (limit - digit) / 10) return false;
        number = number * 10 + digit;
    }
    *value = negative
        ? (number == (zend_ulong) ZEND_LONG_MAX + 1 ? ZEND_LONG_MIN : -(zend_long) number)
        : (zend_long) number;
    return true;
}

static void wm_request(zval *request, const char *operation, wm_db *db)
{
    array_init(request);
    add_assoc_long(request, "version", 1);
    add_assoc_string(request, "op", (char *) operation);
    if (db && db->connection) add_assoc_str(request, "connection", zend_string_copy(db->connection));
}

/* Call the public PHP transport: this also permits native driver contract tests.
 * No callbacks into PHP are made by the database handler while PHP is suspended.
 */
static bool wm_call(pdo_dbh_t *dbh, pdo_stmt_t *stmt, zval *request, zval *result)
{
    smart_str encoded = {0};
    zval function, arguments[2], returned, response;
    ZVAL_UNDEF(result);
    ZVAL_UNDEF(&returned);
    ZVAL_UNDEF(&response);
    if (php_json_encode(&encoded, request, PHP_JSON_UNESCAPED_SLASHES) != SUCCESS) {
        smart_str_free(&encoded);
        return wm_error(dbh, stmt, "HY000", 0, "Cannot encode database request as UTF-8 JSON");
    }
    smart_str_0(&encoded);
    ZVAL_STRING(&function, "php_wasm_host_call");
    ZVAL_STRING(&arguments[0], "mariadb.v1");
    ZVAL_STR(&arguments[1], encoded.s);
    zend_result status = call_user_function(EG(function_table), NULL, &function, &returned, 2, arguments);
    zval_ptr_dtor(&function);
    zval_ptr_dtor(&arguments[0]);
    zval_ptr_dtor(&arguments[1]);
    if (status != SUCCESS || EG(exception)) {
        if (EG(exception)) {
            zval temporary;
            zval *message = zend_read_property(EG(exception)->ce, EG(exception), "message", sizeof("message") - 1, true, &temporary);
            wm_error(dbh, stmt, "HY000", 0, wm_string(message) ? Z_STRVAL_P(message) : "Database host call failed");
            zend_clear_exception();
        } else wm_error(dbh, stmt, "HY000", 0, "Database host call is unavailable");
        if (!Z_ISUNDEF(returned)) zval_ptr_dtor(&returned);
        return false;
    }
    if (Z_TYPE(returned) != IS_STRING || php_json_decode_ex(&response, Z_STRVAL(returned), Z_STRLEN(returned), PHP_JSON_OBJECT_AS_ARRAY | PHP_JSON_BIGINT_AS_STRING, 64) != SUCCESS) {
        zval_ptr_dtor(&returned);
        if (!Z_ISUNDEF(response)) zval_ptr_dtor(&response);
        return wm_protocol_error(dbh, stmt);
    }
    zval_ptr_dtor(&returned);
    zval *version = wm_field(&response, "version"), *ok = wm_field(&response, "ok");
    if (!version || Z_TYPE_P(version) != IS_LONG || Z_LVAL_P(version) != 1 || !ok || (Z_TYPE_P(ok) != IS_TRUE && Z_TYPE_P(ok) != IS_FALSE)) {
        zval_ptr_dtor(&response);
        return wm_protocol_error(dbh, stmt);
    }
    if (Z_TYPE_P(ok) == IS_FALSE) {
        zval *error = wm_field(&response, "error");
        zval *state = error ? wm_field(error, "sqlstate") : NULL;
        zval *number = error ? wm_field(error, "errno") : NULL;
        zval *message = error ? wm_field(error, "message") : NULL;
        bool valid = wm_string(state) && Z_STRLEN_P(state) == 5 && number && Z_TYPE_P(number) == IS_LONG && Z_LVAL_P(number) >= 0 && wm_string(message);
        if (valid) for (size_t i = 0; i < 5; i++) {
            char c = Z_STRVAL_P(state)[i];
            if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'))) valid = false;
        }
        if (valid) wm_error(dbh, stmt, Z_STRVAL_P(state), Z_LVAL_P(number), Z_STRVAL_P(message));
        else wm_protocol_error(dbh, stmt);
        zval_ptr_dtor(&response);
        return false;
    }
    zval *value = wm_field(&response, "result");
    if (!value || Z_TYPE_P(value) != IS_ARRAY) {
        zval_ptr_dtor(&response);
        return wm_protocol_error(dbh, stmt);
    }
    ZVAL_COPY(result, value);
    zval_ptr_dtor(&response);
    return true;
}

static bool wm_query(pdo_dbh_t *dbh, pdo_stmt_t *stmt, const zend_string *sql, zval *result)
{
    wm_db *db = dbh->driver_data;
    zval request;
    wm_request(&request, "query", db);
    add_assoc_str(&request, "sql", zend_string_copy((zend_string *) sql));
    bool success = wm_call(dbh, stmt, &request, result);
    zval_ptr_dtor(&request);
    if (!success) return false;
    zval *columns = wm_field(result, "columns"), *rows = wm_field(result, "rows");
    zval *affected = wm_field(result, "affectedRows"), *insert = wm_field(result, "insertId"), *transaction = wm_field(result, "inTransaction");
    zend_long count;
    if (!columns || Z_TYPE_P(columns) != IS_ARRAY || !zend_array_is_list(Z_ARRVAL_P(columns)) || zend_hash_num_elements(Z_ARRVAL_P(columns)) > INT_MAX ||
        !rows || Z_TYPE_P(rows) != IS_ARRAY || !zend_array_is_list(Z_ARRVAL_P(rows)) ||
        !wm_count(affected, &count) || !wm_decimal(insert) || !transaction || (Z_TYPE_P(transaction) != IS_TRUE && Z_TYPE_P(transaction) != IS_FALSE)) goto invalid;
    zval *column;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(columns), column) {
        zval *name = wm_field(column, "name"), *table = wm_field(column, "table"), *type = wm_field(column, "type"), *charset = wm_field(column, "charset"), *flags = wm_field(column, "flags");
        if (!wm_string(name) || !wm_string(table) || !type || Z_TYPE_P(type) != IS_LONG || !charset || Z_TYPE_P(charset) != IS_LONG || !flags || Z_TYPE_P(flags) != IS_LONG) goto invalid;
    } ZEND_HASH_FOREACH_END();
    zval *row;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(rows), row) {
        if (Z_TYPE_P(row) != IS_ARRAY || !zend_array_is_list(Z_ARRVAL_P(row)) || zend_hash_num_elements(Z_ARRVAL_P(row)) != zend_hash_num_elements(Z_ARRVAL_P(columns))) goto invalid;
        zval *cell;
        ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(row), cell) {
            if (Z_TYPE_P(cell) == IS_NULL) continue;
            if (Z_TYPE_P(cell) != IS_STRING) goto invalid;
            zend_string *decoded = php_base64_decode_ex((const unsigned char *) Z_STRVAL_P(cell), Z_STRLEN_P(cell), true);
            if (!decoded) goto invalid;
            zval_ptr_dtor(cell);
            ZVAL_STR(cell, decoded);
        } ZEND_HASH_FOREACH_END();
    } ZEND_HASH_FOREACH_END();
    if (db->insert_id) zend_string_release(db->insert_id);
    db->insert_id = zend_string_copy(Z_STR_P(insert));
    db->in_transaction = Z_TYPE_P(transaction) == IS_TRUE;
    return true;
invalid:
    zval_ptr_dtor(result);
    ZVAL_UNDEF(result);
    return wm_protocol_error(dbh, stmt);
}

static bool wm_sql(pdo_dbh_t *dbh, const char *sql)
{
    zend_string *query = zend_string_init(sql, strlen(sql), false);
    zval result;
    bool success = wm_query(dbh, NULL, query, &result);
    zend_string_release(query);
    if (success) zval_ptr_dtor(&result);
    return success;
}

static void wm_close(pdo_dbh_t *dbh)
{
    wm_db *db = dbh->driver_data;
    if (!db) return;
    if (db->connection) {
        /* A close is best-effort during unwinding; preserve a pending exception. */
        zend_object *exception = EG(exception);
        EG(exception) = NULL;
        zval request, response;
        wm_request(&request, "close", db);
        if (wm_call(dbh, NULL, &request, &response)) zval_ptr_dtor(&response);
        zval_ptr_dtor(&request);
        if (EG(exception)) zend_clear_exception();
        EG(exception) = exception;
        zend_string_release(db->connection);
    }
    if (db->server_version) zend_string_release(db->server_version);
    if (db->insert_id) zend_string_release(db->insert_id);
    if (db->error_message) zend_string_release(db->error_message);
    efree(db);
    dbh->driver_data = NULL;
}

static bool wm_prepare(pdo_dbh_t *dbh, zend_string *sql, pdo_stmt_t *stmt, zval *options)
{
    (void) sql;
    if (pdo_attr_lval(options, PDO_ATTR_CURSOR, PDO_CURSOR_FWDONLY) != PDO_CURSOR_FWDONLY) return wm_error(dbh, NULL, "HYC00", 0, "Only forward-only cursors are supported");
    wm_stmt *statement = ecalloc(1, sizeof(wm_stmt));
    ZVAL_UNDEF(&statement->result);
    statement->row = -1;
    stmt->driver_data = statement;
    stmt->methods = &wm_stmt_methods;
    stmt->supports_placeholders = PDO_PLACEHOLDER_NONE;
    return true;
}

static zend_long wm_exec(pdo_dbh_t *dbh, const zend_string *sql)
{
    zval result;
    if (!wm_query(dbh, NULL, sql, &result)) return -1;
    zend_long affected = 0;
    wm_count(wm_field(&result, "affectedRows"), &affected);
    zval_ptr_dtor(&result);
    return affected;
}

/* Text must be a conventional quoted literal: Joomla's MysqlDriver::escape()
 * strips its first/last quote. The host enforces the negotiated UTF-8 charset and removes the
 * NO_BACKSLASH_ESCAPES mode before each SQL query. LOBs use binary hex. */
static zend_string *wm_quote(pdo_dbh_t *dbh, const zend_string *input, enum pdo_param_type type)
{
    (void) dbh;
    if (PDO_PARAM_TYPE(type) != PDO_PARAM_LOB) {
        zend_string *quoted = zend_string_safe_alloc(2, ZSTR_LEN(input), 2, false);
        char *output = ZSTR_VAL(quoted);
        *output++ = '\'';
        for (size_t i = 0; i < ZSTR_LEN(input); i++) {
            unsigned char byte = (unsigned char) ZSTR_VAL(input)[i];
            switch (byte) {
                case 0: *output++ = '\\'; *output++ = '0'; break;
                case '\n': *output++ = '\\'; *output++ = 'n'; break;
                case '\r': *output++ = '\\'; *output++ = 'r'; break;
                case 26: *output++ = '\\'; *output++ = 'Z'; break;
                case '\'': *output++ = '\''; *output++ = '\''; break;
                case '\\': case '"': *output++ = '\\'; *output++ = byte; break;
                default: *output++ = byte; break;
            }
        }
        *output++ = '\'';
        *output = '\0';
        ZSTR_LEN(quoted) = (size_t) (output - ZSTR_VAL(quoted));
        return quoted;
    }
    const char *prefix = "X'";
    const char *suffix = "'";
    size_t prefix_length = strlen(prefix), suffix_length = strlen(suffix);
    zend_string *quoted = zend_string_safe_alloc(2, ZSTR_LEN(input), prefix_length + suffix_length, false);
    char *output = ZSTR_VAL(quoted);
    static const char hex[] = "0123456789abcdef";
    memcpy(output, prefix, prefix_length);
    for (size_t i = 0; i < ZSTR_LEN(input); i++) {
        unsigned char byte = (unsigned char) ZSTR_VAL(input)[i];
        output[prefix_length + i * 2] = hex[byte >> 4];
        output[prefix_length + i * 2 + 1] = hex[byte & 15];
    }
    memcpy(output + prefix_length + ZSTR_LEN(input) * 2, suffix, suffix_length);
    output[ZSTR_LEN(quoted)] = '\0';
    return quoted;
}

static bool wm_begin(pdo_dbh_t *dbh) { return wm_sql(dbh, "START TRANSACTION"); }
static bool wm_commit(pdo_dbh_t *dbh) { return wm_sql(dbh, "COMMIT"); }
static bool wm_rollback(pdo_dbh_t *dbh) { return wm_sql(dbh, "ROLLBACK"); }
static bool wm_in_transaction(pdo_dbh_t *dbh) { return ((wm_db *) dbh->driver_data)->in_transaction; }

static bool wm_set_attribute(pdo_dbh_t *dbh, zend_long attribute, zval *value)
{
    switch (attribute) {
        case PDO_ATTR_STRINGIFY_FETCHES:
            /* PDO core owns dbh->stringify and applies bound-column overrides. */
            return true;
        case PDO_ATTR_EMULATE_PREPARES:
            if (zend_is_true(value)) return true;
            return wm_error(dbh, NULL, "HYC00", 0, "Native prepared statements are not supported; emulated prepares are required");
        case PDO_ATTR_AUTOCOMMIT: {
            bool enabled = zend_is_true(value);
            if (!wm_sql(dbh, enabled ? "SET autocommit=1" : "SET autocommit=0")) return false;
            dbh->auto_commit = enabled;
            return true;
        }
        default: return wm_error(dbh, NULL, "IM001", 0, "The requested PDO driver attribute is not supported");
    }
}

static zend_string *wm_last_id(pdo_dbh_t *dbh, const zend_string *name)
{
    if (name && ZSTR_LEN(name)) {
        wm_error(dbh, NULL, "HYC00", 0, "Named sequences are not supported");
        return NULL;
    }
    wm_db *db = dbh->driver_data;
    return db->insert_id ? zend_string_copy(db->insert_id) : zend_string_init("0", 1, false);
}

static void wm_fetch_error(pdo_dbh_t *dbh, pdo_stmt_t *stmt, zval *info)
{
    wm_db *db = dbh->driver_data;
    wm_stmt *statement = stmt ? stmt->driver_data : NULL;
    zend_string *message = statement ? statement->error_message : db->error_message;
    add_next_index_long(info, statement ? statement->error_number : db->error_number);
    if (message) add_next_index_str(info, zend_string_copy(message));
    else add_next_index_null(info);
}

static int wm_get_attribute(pdo_dbh_t *dbh, zend_long attribute, zval *value)
{
    wm_db *db = dbh->driver_data;
    switch (attribute) {
        case PDO_ATTR_SERVER_VERSION: ZVAL_STR_COPY(value, db->server_version); return 1;
        case PDO_ATTR_CLIENT_VERSION: ZVAL_STRING(value, "JoomEngine mariadb-wasm-bridge/" WM_VERSION " protocol/1"); return 1;
        case PDO_ATTR_CONNECTION_STATUS: ZVAL_STRING(value, "Embedded MariaDB WebAssembly"); return 1;
        case PDO_ATTR_SERVER_INFO: ZVAL_STRING(value, "Embedded MariaDB; no TCP connection"); return 1;
        case PDO_ATTR_EMULATE_PREPARES: ZVAL_TRUE(value); return 1;
        case PDO_ATTR_AUTOCOMMIT: ZVAL_BOOL(value, dbh->auto_commit); return 1;
        default: return 0;
    }
}

static int wm_statement_free(pdo_stmt_t *stmt)
{
    wm_stmt *statement = stmt->driver_data;
    if (!Z_ISUNDEF(statement->result)) zval_ptr_dtor(&statement->result);
    if (statement->error_message) zend_string_release(statement->error_message);
    efree(statement);
    stmt->driver_data = NULL;
    return 1;
}

static int wm_statement_execute(pdo_stmt_t *stmt)
{
    wm_stmt *statement = stmt->driver_data;
    if (!Z_ISUNDEF(statement->result)) zval_ptr_dtor(&statement->result);
    ZVAL_UNDEF(&statement->result);
    statement->row = -1;
    if (!wm_query(stmt->dbh, stmt, stmt->active_query_string ? stmt->active_query_string : stmt->query_string, &statement->result)) return 0;
    zval *columns = wm_field(&statement->result, "columns");
    php_pdo_stmt_set_column_count(stmt, (int) zend_hash_num_elements(Z_ARRVAL_P(columns)));
    if (!stmt->columns) stmt->executed = 0;
    if (stmt->column_count) stmt->row_count = (zend_long) zend_hash_num_elements(Z_ARRVAL_P(wm_field(&statement->result, "rows")));
    else wm_count(wm_field(&statement->result, "affectedRows"), &stmt->row_count);
    return 1;
}

static int wm_statement_fetch(pdo_stmt_t *stmt, enum pdo_fetch_orientation orientation, zend_long offset)
{
    (void) offset;
    wm_stmt *statement = stmt->driver_data;
    if (orientation != PDO_FETCH_ORI_NEXT) return wm_error(stmt->dbh, stmt, "HYC00", 0, "Only forward-only fetch is supported");
    if (Z_ISUNDEF(statement->result)) return 0;
    zval *rows = wm_field(&statement->result, "rows");
    if ((zend_ulong) (statement->row + 1) >= zend_hash_num_elements(Z_ARRVAL_P(rows))) return 0;
    statement->row++;
    return 1;
}

static zval *wm_column(pdo_stmt_t *stmt, zend_long index)
{
    wm_stmt *statement = stmt->driver_data;
    if (Z_ISUNDEF(statement->result)) return NULL;
    zval *columns = wm_field(&statement->result, "columns");
    return zend_hash_index_find(Z_ARRVAL_P(columns), (zend_ulong) index);
}

static int wm_statement_describe(pdo_stmt_t *stmt, int index)
{
    zval *column = wm_column(stmt, index);
    if (!column) return 0;
    stmt->columns[index].name = zend_string_copy(Z_STR_P(wm_field(column, "name")));
    stmt->columns[index].maxlen = 0;
    stmt->columns[index].precision = 0;
    return 1;
}

static int wm_statement_column(pdo_stmt_t *stmt, int index, zval *value, enum pdo_param_type *type)
{
    (void) type;
    wm_stmt *statement = stmt->driver_data;
    if (Z_ISUNDEF(statement->result) || statement->row < 0) return 0;
    zval *rows = wm_field(&statement->result, "rows");
    zval *row = zend_hash_index_find(Z_ARRVAL_P(rows), (zend_ulong) statement->row);
    zval *cell = row ? zend_hash_index_find(Z_ARRVAL_P(row), (zend_ulong) index) : NULL;
    if (!cell) return 0;
    if (Z_TYPE_P(cell) == IS_STRING && !stmt->dbh->stringify) {
        zval *column = wm_column(stmt, index);
        zend_long field_type = Z_LVAL_P(wm_field(column, "type"));
        zend_long integer;
        if (wm_integer_type(field_type) && wm_integer(Z_STR_P(cell), &integer)) {
            ZVAL_LONG(value, integer);
            return 1;
        }
        /* FLOAT and DOUBLE are approximate types; DECIMAL remains exact text. */
        if (field_type == 4 || field_type == 5) {
            const char *end;
            double number = zend_strtod(Z_STRVAL_P(cell), &end);
            if (end == Z_STRVAL_P(cell) + Z_STRLEN_P(cell) && isfinite(number)) {
                ZVAL_DOUBLE(value, number);
                return 1;
            }
        }
    }
    ZVAL_COPY(value, cell);
    return 1;
}

static int wm_statement_meta(pdo_stmt_t *stmt, zend_long index, zval *value)
{
    zval *column = wm_column(stmt, index);
    if (!column) return FAILURE;
    array_init(value);
    zend_long field_type = Z_LVAL_P(wm_field(column, "type"));
    bool integer_type = wm_integer_type(field_type) && (field_type != 8 || SIZEOF_ZEND_LONG == 8);
    add_assoc_long(value, "pdo_type", integer_type ? PDO_PARAM_INT : PDO_PARAM_STR);
    add_assoc_str(value, "table", zend_string_copy(Z_STR_P(wm_field(column, "table"))));
    add_assoc_long(value, "mariadb:type", Z_LVAL_P(wm_field(column, "type")));
    add_assoc_long(value, "mariadb:charset", Z_LVAL_P(wm_field(column, "charset")));
    add_assoc_long(value, "mariadb:flags", Z_LVAL_P(wm_field(column, "flags")));
    return SUCCESS;
}

static int wm_statement_close(pdo_stmt_t *stmt)
{
    wm_stmt *statement = stmt->driver_data;
    if (!Z_ISUNDEF(statement->result)) zval_ptr_dtor(&statement->result);
    ZVAL_UNDEF(&statement->result);
    statement->row = -1;
    return 1;
}

static const struct pdo_stmt_methods wm_stmt_methods = {
    .dtor = wm_statement_free, .executer = wm_statement_execute,
    .fetcher = wm_statement_fetch, .describer = wm_statement_describe,
    .get_col = wm_statement_column, .get_column_meta = wm_statement_meta,
    .cursor_closer = wm_statement_close,
};
static const struct pdo_dbh_methods wm_db_methods = {
    .closer = wm_close, .preparer = wm_prepare, .doer = wm_exec, .quoter = wm_quote,
    .begin = wm_begin, .commit = wm_commit, .rollback = wm_rollback,
    .set_attribute = wm_set_attribute, .last_id = wm_last_id,
    .fetch_err = wm_fetch_error, .get_attribute = wm_get_attribute,
    .in_transaction = wm_in_transaction,
};

static int wm_factory(pdo_dbh_t *dbh, zval *options)
{
    wm_db *db = ecalloc(1, sizeof(wm_db));
    dbh->driver_data = db;
    dbh->methods = &wm_db_methods;
    dbh->native_case = PDO_CASE_NATURAL;
    /* Ask PDO to describe result columns immediately after execution, so
     * getColumnMeta() is safe before the first fetch on every supported PHP. */
    dbh->alloc_own_columns = 1;
    if (dbh->is_persistent) {
        wm_error(dbh, NULL, "HYC00", 0, "Persistent PDO handles are not supported; persist the MariaDB bridge instead");
        goto failure;
    }
    if (!zend_hash_str_exists(EG(function_table), "php_wasm_host_call", sizeof("php_wasm_host_call") - 1)) {
        wm_error(dbh, NULL, "IM001", 0, "php_wasm_host_call() is required by pdo_mariadb_wasm");
        goto failure;
    }
    if (!pdo_attr_lval(options, PDO_ATTR_EMULATE_PREPARES, 1)) {
        wm_error(dbh, NULL, "HYC00", 0, "Native prepared statements are not supported");
        goto failure;
    }
    struct pdo_data_src_parser fields[] = {
        {"dbname", "", 0}, {"charset", "utf8mb4", 0}, {"host", "mariadb-wasm", 0},
        {"port", "3306", 0}, {"unix_socket", "", 0},
    };
    php_pdo_parse_data_source(dbh->data_source, dbh->data_source_len, fields, 5);
    bool valid = (strcmp(fields[1].optval, "utf8mb4") == 0 || strcmp(fields[1].optval, "utf8mb3") == 0 || strcmp(fields[1].optval, "utf8") == 0) &&
        (strcmp(fields[2].optval, "mariadb-wasm") == 0 || strcmp(fields[2].optval, "localhost") == 0 || strcmp(fields[2].optval, "127.0.0.1") == 0) &&
        strcmp(fields[3].optval, "3306") == 0 && fields[4].optval[0] == '\0';
    zval request, result;
    wm_request(&request, "connect", NULL);
    add_assoc_string(&request, "database", fields[0].optval);
    add_assoc_string(&request, "charset", fields[1].optval);
    add_assoc_string(&request, "user", dbh->username ? dbh->username : "root");
    add_assoc_string(&request, "password", dbh->password ? dbh->password : "");
    for (int i = 0; i < 5; i++) if (fields[i].freeme) efree(fields[i].optval);
    if (!valid) {
        zval_ptr_dtor(&request);
        wm_error(dbh, NULL, "HYC00", 0, "Only the local embedded endpoint and UTF-8 charsets are supported");
        goto failure;
    }
    bool success = wm_call(dbh, NULL, &request, &result);
    zval_ptr_dtor(&request);
    if (!success) goto failure;
    zval *connection = wm_field(&result, "connection"), *version = wm_field(&result, "serverVersion");
    if (!wm_string(connection) || Z_STRLEN_P(connection) == 0 || !wm_string(version)) {
        zval_ptr_dtor(&result);
        wm_protocol_error(dbh, NULL);
        goto failure;
    }
    db->connection = zend_string_copy(Z_STR_P(connection));
    db->server_version = zend_string_copy(Z_STR_P(version));
    db->insert_id = zend_string_init("0", 1, false);
    zval_ptr_dtor(&result);
    if (!dbh->auto_commit && !wm_sql(dbh, "SET autocommit=0")) goto failure;
    return 1;
failure:
    pdo_throw_exception((unsigned int) db->error_number, db->error_message ? ZSTR_VAL(db->error_message) : "Cannot connect to MariaDB WASM", &dbh->error_code);
    return 0;
}

static pdo_driver_t wm_driver = { PDO_DRIVER_HEADER(mysql), wm_factory };
static PHP_MINIT_FUNCTION(pdo_mariadb_wasm) { return php_pdo_register_driver(&wm_driver); }
static PHP_MSHUTDOWN_FUNCTION(pdo_mariadb_wasm) { php_pdo_unregister_driver(&wm_driver); return SUCCESS; }
static PHP_MINFO_FUNCTION(pdo_mariadb_wasm)
{
    php_info_print_table_start();
    php_info_print_table_row(2, "MariaDB WASM PDO driver", WM_VERSION);
    php_info_print_table_row(2, "Host protocol", "mariadb.v1");
    php_info_print_table_end();
}
static const zend_module_dep wm_dependencies[] = {
    ZEND_MOD_REQUIRED("pdo")
    ZEND_MOD_REQUIRED("json")
    ZEND_MOD_CONFLICTS("pdo_mysql")
    ZEND_MOD_END
};
zend_module_entry pdo_mariadb_wasm_module_entry = {
    STANDARD_MODULE_HEADER_EX, NULL, wm_dependencies, "pdo_mariadb_wasm", NULL,
    PHP_MINIT(pdo_mariadb_wasm), PHP_MSHUTDOWN(pdo_mariadb_wasm), NULL, NULL,
    PHP_MINFO(pdo_mariadb_wasm), WM_VERSION, STANDARD_MODULE_PROPERTIES
};
#ifdef COMPILE_DL_PDO_MARIADB_WASM
ZEND_GET_MODULE(pdo_mariadb_wasm)
#endif
