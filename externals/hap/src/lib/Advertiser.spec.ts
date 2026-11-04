import { EventEmitter } from "events";
import { AvahiAdvertiser, CiaoAdvertiser, PairingFeatureFlag, ResolvedAdvertiser, StatusFlag } from "./Advertiser";
import { AccessoryInfo } from "./model/AccessoryInfo";

const mockBuses: { connection: EventEmitter }[] = [];

// the system bus, as @homebridge/dbus-native gives it: a connection that emits "connect" on the next tick, and
// "error" with nobody of its own listening
jest.mock("@homebridge/dbus-native", () => ({
  ...jest.requireActual("@homebridge/dbus-native"),
  systemBus: () => {
    const connection = Object.assign(new EventEmitter(), { stream: { destroy: jest.fn() } });
    process.nextTick(() => connection.emit("connect"));
    const bus = { connection, invoke: jest.fn() };
    mockBuses.push(bus);
    return bus;
  },
}));

describe(CiaoAdvertiser, () => {
  describe("ff and sf", () => {
    it("should correctly format pairing feature flags", () => {
      expect(CiaoAdvertiser.ff()).toEqual(0);
      expect(CiaoAdvertiser.ff(PairingFeatureFlag.SUPPORTS_HARDWARE_AUTHENTICATION)).toEqual(1);
      expect(CiaoAdvertiser.ff(PairingFeatureFlag.SUPPORTS_SOFTWARE_AUTHENTICATION)).toEqual(2);
      expect(CiaoAdvertiser.ff(
        PairingFeatureFlag.SUPPORTS_HARDWARE_AUTHENTICATION,
        PairingFeatureFlag.SUPPORTS_SOFTWARE_AUTHENTICATION,
      )).toEqual(3);
    });

    it("should correctly format status flags", () => {
      expect(CiaoAdvertiser.sf()).toEqual(0);

      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED)).toEqual(1);
      expect(CiaoAdvertiser.sf(StatusFlag.NOT_JOINED_WIFI)).toEqual(2);
      expect(CiaoAdvertiser.sf(StatusFlag.PROBLEM_DETECTED)).toEqual(4);

      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED, StatusFlag.NOT_JOINED_WIFI)).toEqual(3);
      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED, StatusFlag.PROBLEM_DETECTED)).toEqual(5);
      expect(CiaoAdvertiser.sf(StatusFlag.NOT_JOINED_WIFI, StatusFlag.PROBLEM_DETECTED)).toEqual(6);

      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED, StatusFlag.NOT_JOINED_WIFI, StatusFlag.PROBLEM_DETECTED)).toEqual(7);
    });
  });
});

describe("D-Bus advertisers", () => {
  beforeEach(() => {
    mockBuses.length = 0;
  });

  it("should warn about a connection error on every system bus it opens instead of crashing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      new AvahiAdvertiser(AccessoryInfo.create("AA:BB:CC:DD:EE:FF"));
      new ResolvedAdvertiser(AccessoryInfo.create("AA:BB:CC:DD:EE:FF"));
      await new Promise(resolve => process.nextTick(resolve)); // the buses connect on the next tick

      expect(mockBuses).toHaveLength(2);
      for (const bus of mockBuses) {
        expect(() => bus.connection.emit("error", new Error("read ECONNRESET"))).not.toThrow();
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("read ECONNRESET"));
    } finally {
      warn.mockRestore();
    }
  });

  it("should not warn when the system bus cannot be reached while checking availability", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const advertiser of [AvahiAdvertiser, ResolvedAdvertiser]) {
        const available = advertiser.isAvailable();
        // fails before the bus connects on the next tick
        mockBuses[mockBuses.length - 1].connection.emit("error", new Error("connect ENOENT /var/run/dbus/system_bus_socket"));
        await expect(available).resolves.toBe(false);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
