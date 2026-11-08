import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";

describe("ApiRequestError", () => {
  it("status と code を持つ", () => {
    const error = new ApiRequestError(403, "FORBIDDEN", "権限がありません");
    expect(error.status).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("権限がありません");
    expect(error.name).toBe("ApiRequestError");
  });
});
