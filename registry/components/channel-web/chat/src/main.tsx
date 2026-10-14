import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownImages } from "@/components/pikit/markdown";
import { App } from "./app";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    {/* An answer's image of another site is a link: it never loads an address the answer chose (the CSP refuses it too). */}
    <MarkdownImages.Provider value="same-origin">
      <App />
    </MarkdownImages.Provider>
  </StrictMode>,
);
