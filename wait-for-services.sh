#!/bin/bash

# Wait for Redis to be ready
echo "Waiting for Redis to be ready..."
until redis-cli -h redis ping; do
  echo "Redis is unavailable - sleeping"
  sleep 2
done
echo "Redis is ready!"

# Wait for Azurite Queue service to be ready
echo "Waiting for Azurite Queue service to be ready..."
until curl -s -f "http://azurite:10001/devstoreaccount1?comp=properties&restype=service" > /dev/null; do
  echo "Azurite Queue service is unavailable - sleeping"
  sleep 2
done
echo "Azurite Queue service is ready!"

# Wait for Azurite Blob service to be ready
echo "Waiting for Azurite Blob service to be ready..."
until curl -s -f "http://azurite:10000/devstoreaccount1?comp=properties&restype=service" > /dev/null; do
  echo "Azurite Blob service is unavailable - sleeping"
  sleep 2
done
echo "Azurite Blob service is ready!"

echo "All services are ready! Starting application..."
exec "$@"

