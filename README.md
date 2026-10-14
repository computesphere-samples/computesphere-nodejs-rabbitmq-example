# Node.js + RabbitMQ example

A web service that hands jobs to a background worker through [RabbitMQ](https://www.rabbitmq.com). You type some text and the web service puts it on the `jobs` queue. The worker takes it, counts the words, reverses the text and sends the answer back, and the page shows it.

One image runs both halves: `ROLE=web` (the default) or `ROLE=worker`. It's a small starting point for any Node.js app that moves slow work off the request path with a queue on [ComputeSphere](https://computesphere.com).

## Deploy on ComputeSphere

This `computesphere.yaml` creates a SphereQueue (RabbitMQ), a web service and a background worker, and passes the queue's connection string to both as a secret:

```yaml
version: "2"
project:
  name: rabbitmq-jobs
environments:
  - name: production
services:
  - name: queue
    type: rabbitmq
    instance_type: sq-1c-2g-s20g
  - name: web
    type: web-service
    image: quay.io/computesphere/computesphere-nodejs-rabbitmq-example:1.0.0
    port: 3000
    instance_type: sl-0.25c-512m
    health_check_path: /healthz
    secret_vars:
      AMQP_URL: { fromService: queue, property: uri }
  - name: worker
    type: background-worker
    image: quay.io/computesphere/computesphere-nodejs-rabbitmq-example:1.0.0
    instance_type: sl-0.25c-512m
    env_vars:
      ROLE: worker
    secret_vars:
      AMQP_URL: { fromService: queue, property: uri }
```

Add spherelets to the worker to take jobs in parallel: each worker takes one job at a time (`prefetch 1`), and RabbitMQ shares the queue among them.

## Endpoints (web)

| Path | What it does |
|---|---|
| `GET /` | A form to send a job |
| `POST /jobs` | Sends the text as a job and shows the worker's answer (waits up to 15 seconds) |
| `GET /healthz` | `200` while connected to RabbitMQ, `503` otherwise |
| `GET /selftest` | `200` when a test job goes to the worker and its answer comes back, so the web service, the queue and the worker are all working |

## Settings

| Variable | Default | |
|---|---|---|
| `ROLE` | `web` | `web` or `worker`. |
| `AMQP_URL` | `amqp://guest:guest@localhost:5672` | The connection string. An `amqps://` URL connects over TLS. |
| `CA_DIR` | `/etc/computesphere/db` | Over TLS, every `*.crt` file in this directory is trusted to sign the server's certificate. It's read again on each connection attempt, so the app waits until the certificate is there. |
| `PORT` | `3000` | The web role's port. |

## Run it locally

```sh
docker run -d --name rabbitmq -p 5672:5672 rabbitmq:4-alpine
npm install
ROLE=worker npm start &
npm start
# open http://localhost:3000
```

## How it works

- Jobs go to the durable `jobs` queue as persistent messages. The answer comes back on RabbitMQ's [direct reply-to](https://www.rabbitmq.com/docs/direct-reply-to), matched by correlation id, so no reply queue is declared.
- Both roles reconnect after the connection drops, trying every 5 seconds and reading the CA directory again each time.

## License

[MIT](LICENSE)
