# eNote

A lightweight note-taking application containerized for easy deployment.

## Quick Start (Docker Compose)

Create a `docker-compose.yml` file and run `docker compose up -d`.

```yaml
version: '3.8'

services:
  enote:
    image: op09090/enote:latest
    container_name: enote
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - APP_PASSWORD=your_secure_password # Access password
      - JWT_SECRET=your_jwt_secret        # Secret for session tokens
      - DB_PATH=/app/data/enote.db        # (Optional)
      - STORAGE_PATH=/app/data/storage    # (Optional)
    restart: unless-stopped
```

## Configuration

- **APP_PASSWORD**: Set this to your desired password to access the app.
- **JWT_SECRET**: Set a random string for token generation.
- **Data Persistence**: All notes and files are stored in the `./data` folder on your host machine.
