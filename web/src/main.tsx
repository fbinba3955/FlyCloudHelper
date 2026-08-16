import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "@/router";
import "@/styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("FlyCloudHelper Web 缺少根节点 #root");
}

/**
 * 启动 FlyCloudHelper Web 单页应用。
 */
function startApplication(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

startApplication(rootElement);
