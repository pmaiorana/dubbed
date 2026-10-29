import { defineConfig } from "spacefast/config";

// Static site lives in public/. The worker entry is resolved relative to that
// folder, hence the "../".
export default defineConfig({
  "name": "Dubbed",
  "build": {
    "outputDirectory": "public"
  },
  "runtime": {
    "kind": "functions",
    "entry": "../handler.ts"
  }
});
