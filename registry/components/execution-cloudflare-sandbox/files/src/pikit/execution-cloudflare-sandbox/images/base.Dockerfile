# The base sandbox image (`containers[].images.base`): what an agent `agents` does not name gets.
# linux/amd64 only: Cloudflare Containers run x86-64 (on ARM it would run emulated, 3 s a command).
#
# What execution-cloudflare-sandbox needs in every image: Node (the helper, /usr/local/bin/pikit-sandbox),
# GNU tar and gzip (snapshots: `--null -T -`), /bin/sh, and the workspace root (/workspace by default).
# Add the agent's tools below (git, python3...), or make an image of your own per agent: the README's
# "Images".
FROM --platform=linux/amd64 node:22-alpine
RUN apk add --no-cache tar gzip git ca-certificates \
 && mkdir -p /workspace
COPY pikit-sandbox /usr/local/bin/pikit-sandbox
RUN chmod 0755 /usr/local/bin/pikit-sandbox
WORKDIR /workspace
# The container only runs what the Durable Object execs in it.
CMD ["sleep", "infinity"]
