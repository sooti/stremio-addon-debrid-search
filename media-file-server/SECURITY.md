# Python File Server Security

The Python file server supports simple password authentication to secure access.

## Setup

### Method 1: Set in Stremio Addon (Recommended)

1. Go to your addon configuration page
2. Add a Usenet service
3. Enter the **File Server Password** field (any simple password you want)
4. This password is saved in your Stremio addon URL and used automatically

### Method 2: Environment Variable (Server-wide)

1. **Set a simple password:**
   ```bash
   export USENET_API_KEY=my_simple_password
   export USENET_FILE_SERVER_API_KEY=my_simple_password
   ```

2. **Restart the services:**
   ```bash
   docker-compose down
   docker-compose up -d
   ```

## How it works

- The Python server checks for the password in:
  1. `X-API-Key` HTTP header
  2. `?key=XXX` query parameter (for direct browser/app access)
  3. `Authorization: Bearer XXX` header

- The Node.js server automatically adds the password from your config

- If no password is configured, authentication is disabled (backward compatible)

## Testing

```bash
# Without auth (will fail if password is set)
curl http://localhost:3003/api/list

# With auth header
curl -H "X-API-Key: my_simple_password" http://localhost:3003/api/list

# With query parameter (for browsers/apps)
curl "http://localhost:3003/api/list?key=my_simple_password"
```

## Notes

- Use a simple password you can remember and type on your phone/TV
- The password is sent in the addon URL, so use HTTPS in production
- You can use different passwords for different users by giving them different addon URLs
