# Build stage
FROM node:20-slim AS build

WORKDIR /app

# Install dependencies for building
COPY package*.json ./
RUN npm install

# Copy source and build the React app
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

# Install Puppeteer dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    librandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxshmfence1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the built app and server files
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY server.js ./

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose the port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
