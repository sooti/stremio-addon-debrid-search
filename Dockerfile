# Use an official Node.js image
FROM node:20

# Set working directory inside container
WORKDIR /app

# Copy only package.json and package-lock.json first (better build caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy rest of the project files
COPY . .

# Expose app port (optional, e.g. if your app runs on 3000)
EXPOSE 6907

# Start the dev server (using nodemon or your dev script)
CMD ["npm", "run", "start"]
