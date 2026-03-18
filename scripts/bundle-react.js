const esbuild = require("esbuild");
const path = require("path");

const outfile = path.join(__dirname, "..", "nodes", "vendor", "react-19.production.min.js");

esbuild.buildSync({
  stdin: {
    contents: `
      import React from "react";
      import ReactDOM from "react-dom";
      import { createRoot } from "react-dom/client";
      window.React = React;
      window.ReactDOM = ReactDOM;
      window.ReactDOM.createRoot = createRoot;
    `,
    resolveDir: path.join(__dirname, ".."),
  },
  bundle: true,
  format: "iife",
  minify: true,
  outfile,
  target: ["es2020"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

const fs = require("fs");
const size = (fs.statSync(outfile).size / 1024).toFixed(1);
console.log(`Built ${outfile} (${size} KB)`);

