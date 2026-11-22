import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import RemoteScanner from "./RemoteScanner.jsx";
import "./styles.css";

const Page = window.location.pathname === "/scanner" ? RemoteScanner : App;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
