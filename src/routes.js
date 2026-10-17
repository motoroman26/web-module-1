const express = require("express");
const service = require("./service");

const router = express.Router();

function orderResponse(order) {
  return {
    id: order.id,
    customerName: order.customerName,
    items: order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: item.price,
    })),
    total: order.total,
    status: order.status,
  };
}

function validationProblem(message, details) {
  return {
    error: {
      code: "VALIDATION_ERROR",
      message,
      details,
    },
  };
}

function notFoundProblem() {
  return {
    error: {
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    },
  };
}

router.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", version: "1.0" });
});

router.post("/orders", (req, res, next) => {
  try {
    const errors = service.validateCreateOrder(req.body);

    if (errors.length > 0) {
      return res.status(400).json(validationProblem("Invalid order", errors));
    }

    const order = service.createOrder(req.body);
    return res
      .status(201)
      .location(`/orders/${order.id}`)
      .json(orderResponse(order));
  } catch (error) {
    return next(error);
  }
});

router.get("/orders", (req, res) => {
  const orders = service.listOrders().map(orderResponse);
  res.status(200).json({ orders, count: orders.length });
});

router.get("/orders/:id", (req, res, next) => {
  try {
    const order = service.getOrder(req.params.id);

    if (!order) {
      return res.status(404).json(notFoundProblem());
    }

    return res.status(200).json(orderResponse(order));
  } catch (error) {
    return next(error);
  }
});

router.delete("/orders/:id", (req, res, next) => {
  try {
    const order = service.getOrder(req.params.id);

    if (!order) {
      return res.status(404).json(notFoundProblem());
    }

    service.deleteOrder(req.params.id);
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
