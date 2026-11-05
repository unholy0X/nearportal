/// <reference types="vite/client" />
import { PortalApp } from "./Portal.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TasksPage } from "./Tasks.tsx";

function App() {
  const path = location.pathname;
  if (path.startsWith("/tasks")) return <TasksPage />;
  return <PortalApp />;
}

// The /tasks diagnostic page keeps its global stylesheet; workspace routes never load it.
const legacyRoute = /^\/tasks/.test(location.pathname);
void (legacyRoute ? import("./styles.css") : Promise.resolve()).then(() =>
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>),
);
