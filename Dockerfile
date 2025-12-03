FROM node:18-slim

# Install FFmpeg and Whisper dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Whisper
RUN pip3 install --no-cache-dir openai-whisper

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app files
COPY . .

# Create required directories
RUN mkdir -p temp bgm jobs output

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
