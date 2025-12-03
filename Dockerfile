FROM node:18-slim

# Install FFmpeg and Python (without Whisper for faster builds)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Optionally install Whisper (comment out to skip subtitles and speed up deployment)
# RUN python3 -m venv /opt/venv && \
#     /opt/venv/bin/pip install --upgrade pip && \
#     /opt/venv/bin/pip install openai-whisper

# Add virtual environment to PATH (if using Whisper)
# ENV PATH="/opt/venv/bin:$PATH"

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
