# deployment-celld on ECS on EC2: celld's release image, with the entrypoint that keeps a node's
# identity and advertises the task's IP (entrypoint.sh). A template (README, "Running a fleet", ECS):
#   docker build -t <account>.dkr.ecr.<region>.amazonaws.com/pikit-celld:0.6.2 nodes/ecs
# Every node of a fleet runs the same celld version (celld's upgrade notes say which can roll).
FROM ghcr.io/denoland/celld:v0.6.2
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl jq \
	&& rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/pikit-celld-entrypoint
RUN chmod 0755 /usr/local/bin/pikit-celld-entrypoint
ENTRYPOINT ["/usr/local/bin/pikit-celld-entrypoint"]
