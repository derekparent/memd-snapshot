import { it } from "vitest";
import { hold } from "./hold.js";

it("holds a worker and a child for a minute", () => hold("a"));
