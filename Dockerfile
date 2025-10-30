# Use an official Node.js image
FROM node:20.18.1

# Set working directory inside container
WORKDIR /app

# Install git and build tools required for dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy only package.json and package-lock.json first (better build caching)
COPY package*.json ./
COPY pnpm-lock.yaml ./

# Install pnpm and then dependencies
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile

# Copy rest of the project files
COPY . .

# Expose app port (optional, e.g. if your app runs on 3000)
EXPOSE 6907

# Start the dev server (using nodemon or your dev script)
CMD ["npm", "run", "start"]
