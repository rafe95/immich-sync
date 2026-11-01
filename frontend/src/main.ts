import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { applyPref, loadPref } from "./lib/theme.ts";

applyPref(loadPref());

export default mount(App, { target: document.getElementById("app")! });
