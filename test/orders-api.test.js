const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../app");

let server;
let baseUrl;

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Orders API contract", () => {
  test("health endpoint is available", async () => {
    const response = await request("/health");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
  });

  test("rejects invalid order input with 400", async () => {
    const response = await request("/orders", {
      method: "POST",
      body: JSON.stringify({ customerName: "", items: [] }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.ok(body.error.details.length >= 2);
  });

  test("creates, lists, retrieves and deletes an order", async () => {
    const creationResponse = await request("/orders", {
      method: "POST",
      body: JSON.stringify({
        customerName: "  Alex  ",
        total: 1,
        status: "paid",
        items: [
          { name: "Keyboard", quantity: 1, price: 120 },
          { name: "Cable", quantity: 2, price: 7.25 },
        ],
      }),
    });
    const created = await creationResponse.json();

    assert.equal(creationResponse.status, 201);
    assert.match(creationResponse.headers.get("location"), /^\/orders\/ord-/);
    assert.match(created.id, /^ord-/);
    assert.equal(created.customerName, "Alex");
    assert.equal(created.total, 134.5);
    assert.equal(created.status, "created");

    const listResponse = await request("/orders");
    const list = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(list.count, 1);
    assert.equal(list.orders[0].id, created.id);

    const getResponse = await request(`/orders/${created.id}`);
    const retrieved = await getResponse.json();

    assert.equal(getResponse.status, 200);
    assert.deepEqual(retrieved, created);

    const deleteResponse = await request(`/orders/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 204);
    assert.equal(await deleteResponse.text(), "");

    const afterDeleteResponse = await request(`/orders/${created.id}`);
    const afterDelete = await afterDeleteResponse.json();

    assert.equal(afterDeleteResponse.status, 404);
    assert.equal(afterDelete.error.code, "ORDER_NOT_FOUND");
  });

  test("returns 404 for an unknown order", async () => {
    const response = await request("/orders/ord-does-not-exist");
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "ORDER_NOT_FOUND");
  });
});
