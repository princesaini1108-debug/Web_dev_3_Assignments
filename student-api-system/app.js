const express = require("express");

const studentRoutes = require("./routes/studentRoutes");
const logger = require("./middleware/logger");

const app = express();

app.use(express.json());

app.use(logger);

app.use("/students", studentRoutes);

app.get("/", (req, res) => {
    res.send("Student Management API is running");
});

app.use((req, res) => {
    res.status(404).json({
        message: "Route not found"
    });
});

app.listen(3000, () => {
    console.log("server started ....");
});