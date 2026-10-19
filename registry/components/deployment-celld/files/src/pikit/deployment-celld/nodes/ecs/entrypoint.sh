#!/bin/sh
# deployment-celld on ECS on EC2: starts celld as a node that keeps its identity and its disk across
# task restarts, advertising this task's private IP to its peers. A template (README, "Running a
# fleet", ECS); nodes/ecs/Dockerfile puts it in front of celld's image.
#
# - The disk: /var/lib/celld is the instance's volume (task-definition.json's `celld-state`, a host
#   path), and the service places one task per instance (`distinctInstance`), so a restarted task on
#   that instance finds its disk again. Not Fargate: its tasks come back with an empty disk, and a node
#   that cannot vouch for its acknowledged writes leaves conversations blocked.
# - The identity: made once on that disk (`node-id`), the same at every restart.
# - The address: the task's own IP (awsvpc), from the ECS task metadata endpoint, for peers
#   (CELLD_ADVERTISE, port 8081). The Worker listens on every address of the task (port 8080): the
#   load balancer's target, and the container's health check on 127.0.0.1. The task's security group
#   lets 8080 in from the load balancer only, and 8081 from the fleet's own security group only.
set -eu

STATE=/var/lib/celld
mkdir -p "$STATE/watch"
if [ ! -s "$STATE/node-id" ]; then
	printf 'ecs-%s\n' "$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" >"$STATE/node-id.tmp"
	mv "$STATE/node-id.tmp" "$STATE/node-id"
fi

: "${ECS_CONTAINER_METADATA_URI_V4:?not on ECS: no task metadata endpoint}"
IP=$(curl -fsS --retry 5 --retry-delay 1 "$ECS_CONTAINER_METADATA_URI_V4" | jq -r '.Networks[0].IPv4Addresses[0]')
case "$IP" in
"" | null)
	echo "pikit-celld: no IPv4 address in the task metadata (networkMode must be awsvpc)" >&2
	exit 1
	;;
esac

CELLD_NODE=$(cat "$STATE/node-id")
CELLD_WATCH="$STATE/watch"
CELLD_ADDR="0.0.0.0:8080"
CELLD_INTERNAL_ADDR="$IP:8081"
CELLD_ADVERTISE="$IP:8081"
export CELLD_NODE CELLD_WATCH CELLD_ADDR CELLD_INTERNAL_ADDR CELLD_ADVERTISE
echo "pikit-celld: node $CELLD_NODE at $IP" >&2
exec /usr/local/bin/celld "$@"
