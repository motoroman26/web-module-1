const express = require("express");
const routes = require("./src/routes");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(routes);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "Route not found",
    },
  });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid JSON body",
        details: ["Request body must contain valid JSON"],
      },
    });
  }

  console.error(error);
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Unexpected server error",
    },
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Orders API is running on http://localhost:${PORT}`);
  });
}

module.exports = app;
