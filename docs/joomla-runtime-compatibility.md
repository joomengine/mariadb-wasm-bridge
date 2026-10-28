# Joomla runtime compatibility

Joomla's configuration validation can request the standard `utf8` connection charset. The bridge must negotiate the requested supported MariaDB charset while retaining `utf8mb4` as its default.

Validation covers explicit charset selection, Unicode round trips, native PDO metadata, request cleanup and Joomla configuration behavior. The engine binary and release 0.1.3 remain unchanged while this source change is reviewed.
