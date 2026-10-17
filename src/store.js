const orders = [];

function findById(id) {
  return orders.find((order) => order.id === id) ?? null;
}

function add(order) {
  orders.push(order);
}

function remove(id) {
  const index = orders.findIndex((order) => order.id === id);
  if (index === -1) return false;
  orders.splice(index, 1);
  return true;
}

function list() {
  return [...orders];
}

module.exports = { findById, add, remove, list };
