import Docker from "dockerode";
import type { Env } from "./config.js";

// Thin wrapper around dockerode, behind an interface so tests can supply a
// fake client instead of touching a real Docker socket (docs/meet-bot.md's
// testing strategy: "orchestrator tests with a fake docker client").

export type ContainerStatus = {
  running: boolean;
  exitCode: number | null;
};

export interface DockerClient {
  runDetached(opts: {
    name: string;
    image: string;
    env: Record<string, string>;
    network?: string;
  }): Promise<{ id: string }>;
  inspect(containerId: string): Promise<ContainerStatus | null>;
  removeForce(containerId: string): Promise<void>;
}

export function createDockerClient(env: Env): DockerClient {
  const docker = new Docker({ socketPath: env.DOCKER_SOCKET_PATH });

  return {
    async runDetached({ name, image, env: containerEnv, network }) {
      const container = await docker.createContainer({
        name,
        Image: image,
        Env: Object.entries(containerEnv).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          ...(network ? { NetworkMode: network } : {}),
          ShmSize: 512 * 1024 * 1024, // Chromium under Xvfb wants more than Docker's 64MB default
        },
      });
      await container.start();
      return { id: container.id };
    },

    async inspect(containerId) {
      try {
        const info = await docker.getContainer(containerId).inspect();
        return { running: info.State.Running, exitCode: info.State.ExitCode ?? null };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async removeForce(containerId) {
      try {
        await docker.getContainer(containerId).remove({ force: true });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    err.statusCode === 404
  );
}
