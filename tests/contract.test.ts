import { MockPayPal } from "../src/paypal/mock";
import { MemoryStore } from "../src/store";
import { payPalContract } from "./contract";

const mock = new MockPayPal(new MemoryStore(), "http://desk.test");
payPalContract("mock", () => mock);
