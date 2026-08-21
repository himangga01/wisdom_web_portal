import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "./app/router";
import { SessionProvider } from "./app/session";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Administrator root element is missing");

createRoot(root).render(
  <StrictMode>
    <SessionProvider>
      <AppRouter />
    </SessionProvider>
  </StrictMode>,
);
