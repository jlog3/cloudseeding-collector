#!/bin/sh
# Ensure database exists before starting
if [ ! -f "${DB_PATH:-./cloudseeding.db}" ]; then
  echo "Initializing database..."
  node setup-db.js
fi
exec "$@"
