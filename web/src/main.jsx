import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { connectWs, loadProject, loadPipeline, loadArtifacts } from "./store.js";
import "./styles.css";

connectWs();
loadProject()
  .then(() => Promise.all([loadPipeline(), loadArtifacts()]))
  .catch((e) => console.error(e));

createRoot(document.getElementById("root")).render(<App />);
