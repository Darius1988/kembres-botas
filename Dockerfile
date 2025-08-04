# Use the official Node.js runtime as the base image
FROM node:18-alpine

# Install build dependencies for sqlite3
RUN apk add --no-cache python3 make g++ sqlite

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Create a directory for the database and set permissions
RUN mkdir -p /app/data && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Create a volume for the database to persist data
VOLUME ["/app"]

# Command to run the application
CMD ["npm", "start"]