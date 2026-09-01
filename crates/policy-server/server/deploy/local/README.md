# Policy Server Local Kubernetes

This directory contains the local-only dependencies for running
`policy-server` in a developer Kubernetes cluster.

Use **minikube** for local policy-server k8s development. The wrapper builds
the server image directly inside minikube's Docker daemon so Kubernetes can run
the image with `imagePullPolicy: Never`. Docker Desktop Kubernetes can use a
separate containerd image store, so it is not the supported self-service path.

The production Helm chart intentionally does not include PostgreSQL or Redis.
For local testing, these manifests create throwaway in-cluster services:

- `postgres.yaml` exposes `postgres:5432`
- `redis.yaml` exposes `redis:6379`
- `create-secret.sh` creates the `policy-server-secrets` Secret expected by the chart

Use the top-level wrapper for the normal flow:

```bash
minikube start --driver=docker
kubectl config use-context minikube
scripts/policy-server-local-k8s.sh up
```

That command builds the server image, loads it into minikube when needed,
applies PostgreSQL and Redis, creates the Secret, installs/upgrades the Helm
release with `values-local.yaml`, starts a background port-forward, and checks
`/health` plus `/readyz`.

The API is exposed at `http://127.0.0.1:8788`, matching the extension's default
`DAMBI_SERVER_URL`. The extension origins in `values-local.yaml` are
placeholders — replace `<your-extension-id>` in `corsAllowedOrigins` and
`oauthAllowedRedirectUris` with your unpacked build's id from
`chrome://extensions`.

To keep that id stable across reloads, generate a key pair and put the public
half in `browser-extension/backend/manifest.json` as `"__chrome__key"`:

```bash
openssl genrsa -out .dambi-extension-key.pem 2048
openssl rsa -in .dambi-extension-key.pem -pubout -outform DER | base64 -w0
```

`.dambi-extension-key.pem` is gitignored — keep it out of the repository.

Useful commands:

```bash
scripts/policy-server-local-k8s.sh status
scripts/policy-server-local-k8s.sh port-forward
scripts/policy-server-local-k8s.sh down
```

Configuration knobs:

```bash
POLICY_SERVER_LOCAL_NAMESPACE=dambi
POLICY_SERVER_LOCAL_RELEASE=dambi
POLICY_SERVER_LOCAL_IMAGE_REPOSITORY=dambi-policy-server
POLICY_SERVER_LOCAL_IMAGE_TAG=dev
POLICY_SERVER_LOCAL_PORT=8788
```

OAuth and API key values can be supplied as environment variables before
running the wrapper or `create-secret.sh`; otherwise local-safe placeholders are
used and OAuth routes will report missing Google credentials when called. Real
Google login still requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with
`http://127.0.0.1:8788/auth/google/callback` registered in Google Console.
