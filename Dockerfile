# -------- Base build stage --------
FROM node:20-slim AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# Install only production dependencies; fall back to npm install if no lockfile
RUN npm ci --omit=dev || npm install --omit=dev

# -------- Runtime stage --------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 6907
CMD ["node", "server.js"]
