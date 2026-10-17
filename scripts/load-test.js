const { performance } = require("node:perf_hooks");

const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const requestCount = positiveInteger(process.env.REQUESTS, 750);
const concurrency = positiveInteger(process.env.CONCURRENCY, 25);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percent / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

function summarize(results) {
  const durations = results.map((result) => result.duration).sort((a, b) => a - b);
  const successful = results.filter((result) => result.ok).length;
  const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);

  return {
    requests: results.length,
    successful,
    failed: results.length - successful,
    average: results.length ? totalDuration / results.length : 0,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
  };
}

async function timedRequest(label, path, options) {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}${path}`, options);
    const body = response.status === 204 ? null : await response.json();

    return {
      label,
      ok: response.ok,
      status: response.status,
      body,
      duration: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: 0,
      error: error.message,
      duration: performance.now() - startedAt,
    };
  }
}

async function createOrder(index) {
  return timedRequest("POST /orders", "/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerName: `Load Test ${index}`,
      items: [{ name: "Notebook", quantity: 1, price: 12.5 }],
    }),
  });
}

function operationFor(index, orderIds) {
  const selector = index % 10;

  if (selector === 0) {
    return timedRequest("GET /health", "/health");
  }

  if (selector === 1) {
    return timedRequest("GET /orders", "/orders");
  }

  if (selector <= 6) {
    const id = orderIds[index % orderIds.length];
    return timedRequest("GET /orders/:id", `/orders/${id}`);
  }

  return createOrder(index).then((result) => {
    if (result.ok && result.body?.id) orderIds.push(result.body.id);
    return result;
  });
}

function printSummary(title, summary) {
  console.log(title);
  console.log(`  Requests: ${summary.requests}`);
  console.log(`  Successful: ${summary.successful}`);
  console.log(`  Failed: ${summary.failed}`);
  console.log(`  Average latency: ${summary.average.toFixed(0)} ms`);
  console.log(`  p50 latency: ${summary.p50.toFixed(0)} ms`);
  console.log(`  p95 latency: ${summary.p95.toFixed(0)} ms`);
  console.log(`  p99 latency: ${summary.p99.toFixed(0)} ms`);
}

async function main() {
  const health = await timedRequest("GET /health", "/health");

  if (!health.ok) {
    throw new Error(`Server is not reachable at ${baseUrl} (status ${health.status})`);
  }

  console.log(`Server: ${baseUrl}`);
  console.log("Preparing sample orders...");

  const seedResults = await Promise.all(
    Array.from({ length: Math.min(concurrency, 12) }, (_, index) => createOrder(index)),
  );
  const orderIds = seedResults
    .filter((result) => result.ok && result.body?.id)
    .map((result) => result.body.id);

  if (orderIds.length === 0) {
    throw new Error("Could not create sample orders");
  }

  const results = new Array(requestCount);
  let nextIndex = 0;
  const startedAt = performance.now();

  async function worker() {
    while (nextIndex < requestCount) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operationFor(index, orderIds);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()),
  );

  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const overall = summarize(results);

  console.log("\nOverall");
  console.log(`  Requests: ${requestCount}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Successful: ${overall.successful}`);
  console.log(`  Failed: ${overall.failed}`);
  console.log(`  Average latency: ${overall.average.toFixed(0)} ms`);
  console.log(`  p50 latency: ${overall.p50.toFixed(0)} ms`);
  console.log(`  p95 latency: ${overall.p95.toFixed(0)} ms`);
  console.log(`  p99 latency: ${overall.p99.toFixed(0)} ms`);
  console.log(`  Throughput: ${(requestCount / elapsedSeconds).toFixed(1)} req/s`);

  const labels = [...new Set(results.map((result) => result.label))].sort();
  console.log("\nBy endpoint");
  for (const label of labels) {
    printSummary(
      label,
      summarize(results.filter((result) => result.label === label)),
    );
  }
}

main().catch((error) => {
  console.error(`Load test could not start: ${error.message}`);
  process.exitCode = 1;
});
