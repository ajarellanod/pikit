# A designer's image (`containers[].images.designer`, `agents: { designer: { image: "designer" } }`):
# headless Chromium, ffmpeg and fonts, for rendering pages, screenshots and video. linux/amd64 only.
# Larger (about 1.2 GB) and slower to pull on a container's first start: give it a larger instance
# (`instance: "standard-2"`) and keep it for the agents that need it.
FROM --platform=linux/amd64 node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium ffmpeg tar gzip git ca-certificates \
      fonts-dejavu fonts-liberation fonts-noto fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace
ENV CHROME_PATH=/usr/bin/chromium PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
COPY pikit-sandbox /usr/local/bin/pikit-sandbox
RUN chmod 0755 /usr/local/bin/pikit-sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
