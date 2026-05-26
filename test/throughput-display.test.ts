import { describe, expect, it } from "vitest";

import { iqrKeptDisplay } from "../src/client/throughput-display";

describe("throughput display helpers", () => {
  it("formats IQR kept counts with one-decimal outlier rates", () => {
    expect(iqrKeptDisplay({ filteredSampleCount: 82, sampleCount: 97 })).toEqual({
      value: "82/97",
      detail: "15.5% outliers"
    });
  });

  it("formats fully kept samples without decimal noise", () => {
    expect(iqrKeptDisplay({ filteredSampleCount: 97, sampleCount: 97 })).toEqual({
      value: "97/97",
      detail: "0% outliers"
    });
  });

  it("handles empty sample sets", () => {
    expect(iqrKeptDisplay({ filteredSampleCount: 0, sampleCount: 0 })).toEqual({
      value: "0/0",
      detail: "0% outliers"
    });
  });
});
