# Apify base image with Node.js and Playwright (Chromium)
FROM apify/actor-node-playwright-chrome:20

# Copy dependency manifests first (layer caching)
COPY package*.json ./

# Install dependencies
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Dependencies installed."

# Copy source code
COPY . ./

# Run the actor
CMD npm start
