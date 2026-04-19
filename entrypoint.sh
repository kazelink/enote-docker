#!/bin/sh
# Fix ownership of the data volume (runs as root before dropping to enote user)
chown -R enote:enote /app/data
exec su-exec enote node src/server.js
