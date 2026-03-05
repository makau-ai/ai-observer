#!/bin/bash
# AI Observer — Start the server
cd "$(dirname "$0")"
echo "Starting AI Observer on http://localhost:8077"
exec uvicorn main:app --port 8077 --host 0.0.0.0
