#!/bin/sh
# Fix ownership of the data volume (runs as root before dropping to enote user)
# Fix ownership only if current owner is not enote (saves time on large volumes)
[ "$(stat -c %U /app/data)" = "enote" ] || chown -R enote:enote /app/data

exec su-exec enote node src/server.js
