import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatX509Certificate,
  isSamlConfigured,
  generateSamlMetadata,
  pickSamlEmail,
  pickSamlDisplayName,
  validateSamlResponse,
  registerSamlRequestId,
} from "../../src/lib/auth/saml.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// validateSamlResponse now checks InResponseTo against a server-side store —
// stub the kv so the unit tests don't touch a real DB.
const kvData = new Map();
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async (k, fallback = null) =>
      kvData.has(k) ? kvData.get(k) : fallback,
    set: async (k, v) => {
      kvData.set(k, v);
    },
    remove: async (k) => {
      kvData.delete(k);
    },
    getAll: async () => Object.fromEntries(kvData),
    setMany: async () => {},
    clear: async () => kvData.clear(),
  }),
}));

describe("SAML 2.0 Auth Engine Utilities", () => {
  describe("formatX509Certificate", () => {
    it("formats raw Base64 string into standard 64-column PEM block", () => {
      const rawBase64 =
        "MIIC1234567890123456789012345678901234567890123456789012345678901234567890";
      const formatted = formatX509Certificate(rawBase64);
      expect(formatted).toContain("-----BEGIN CERTIFICATE-----");
      expect(formatted).toContain("-----END CERTIFICATE-----");
      expect(formatted).toContain(
        "MIIC123456789012345678901234567890123456789012345678901234567890",
      );
      expect(formatted).toContain("\n1234567890\n");
    });

    it("cleans existing PEM header/footer and extra whitespace", () => {
      const rawPem = `
        -----BEGIN CERTIFICATE-----
        MIIC123456789012345678901234567890123456789012345678901234567890
        1234567890
        -----END CERTIFICATE-----
      `;
      const formatted = formatX509Certificate(rawPem);
      expect(formatted).toContain("-----BEGIN CERTIFICATE-----");
      expect(formatted.match(/BEGIN CERTIFICATE/g)?.length).toBe(1);
    });

    it("returns empty string for null, undefined, or invalid inputs", () => {
      expect(formatX509Certificate(null)).toBe("");
      expect(formatX509Certificate(undefined)).toBe("");
      expect(formatX509Certificate("   ")).toBe("");
    });
  });

  describe("isSamlConfigured", () => {
    it("returns true when authMode allows SAML and entryPoint + cert are non-empty", () => {
      expect(
        isSamlConfigured({
          authMode: "saml",
          samlEntryPoint: "https://idp.example.com/sso",
          samlCert: "dummy-cert",
        }),
      ).toBe(true);
      expect(
        isSamlConfigured({
          authMode: "both",
          samlEntryPoint: "https://idp.example.com/sso",
          samlCert: "dummy-cert",
        }),
      ).toBe(true);
    });

    it("returns false if entryPoint or cert is missing", () => {
      expect(
        isSamlConfigured({
          authMode: "saml",
          samlEntryPoint: "https://idp.example.com/sso",
        }),
      ).toBe(false);
      expect(
        isSamlConfigured({ authMode: "saml", samlCert: "dummy-cert" }),
      ).toBe(false);
      expect(isSamlConfigured({})).toBe(false);
    });

    it("returns false when authMode does not allow SAML (password-only)", () => {
      expect(
        isSamlConfigured({
          authMode: "password",
          samlEntryPoint: "https://idp.example.com/sso",
          samlCert: "dummy-cert",
        }),
      ).toBe(false);
    });
  });

  describe("generateSamlMetadata", () => {
    it("generates valid SP XML metadata with Entity ID and ACS binding", () => {
      const settings = {
        samlEntryPoint: "https://idp.example.com/sso",
        samlIssuer: "urn:9router:sp",
        samlCert:
          "MIIC123456789012345678901234567890123456789012345678901234567890",
      };
      const xml = generateSamlMetadata("https://localhost:20127", settings);
      expect(xml).toContain('entityID="urn:9router:sp"');
      expect(xml).toContain(
        'Location="https://localhost:20127/api/auth/saml/acs"',
      );
      expect(xml).toContain('WantAssertionsSigned="true"');
    });
  });

  describe("InResponseTo Replay Validation", () => {
    beforeEach(() => kvData.clear());

    it("throws error when InResponseTo is missing from the assertion", async () => {
      const settings = { samlCert: "dummy-cert" };
      const rawXml = Buffer.from('<Response ID="123"></Response>').toString(
        "base64",
      );
      await expect(
        validateSamlResponse(
          null,
          { SAMLResponse: rawXml },
          "req-123",
          settings,
        ),
      ).rejects.toThrow(/InResponseTo/);
    });

    it("throws error when InResponseTo was never issued (replay/unknown)", async () => {
      const settings = { samlCert: "dummy-cert" };
      const rawXml = Buffer.from(
        '<Response InResponseTo="unknown-id"></Response>',
      ).toString("base64");
      await expect(
        validateSamlResponse(
          null,
          { SAMLResponse: rawXml },
          "req-123",
          settings,
        ),
      ).rejects.toThrow(/possible replay/);
    });

    it("consumes an issued requestId once, then rejects the replay", async () => {
      const settings = { samlCert: "dummy-cert" };
      await registerSamlRequestId("req-valid");
      const rawXml = Buffer.from(
        '<Response InResponseTo="req-valid"></Response>',
      ).toString("base64");
      // First validation passes the replay check (then fails in the real SAML
      // lib validation, which is not under test here).
      await validateSamlResponse(
        null,
        { SAMLResponse: rawXml },
        "req-valid",
        settings,
      )
        .then(() => {
          throw new Error("expected downstream validation to fail");
        })
        .catch((e) => {
          if (!/possible replay/.test(e.message)) throw e;
        });
      // Second use of the same requestId must be rejected as a replay.
      await expect(
        validateSamlResponse(
          null,
          { SAMLResponse: rawXml },
          "req-valid",
          settings,
        ),
      ).rejects.toThrow(/possible replay/);
    });

    it("throws error if samlCert is not configured", async () => {
      const rawXml = Buffer.from('<Response ID="123"></Response>').toString(
        "base64",
      );
      await expect(
        validateSamlResponse(null, { SAMLResponse: rawXml }, "req-123", {}),
      ).rejects.toThrow(/Certificate/);
    });
  });

  describe("Claims Extraction", () => {
    const mockProfile = {
      email: "user@example.com",
      displayName: "Jane Doe",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": [
        "custom@example.com",
      ],
      customEmail: "custom-email@example.com",
      customName: "Custom User",
    };

    it("pickSamlEmail extracts custom attribute or common claims", () => {
      expect(pickSamlEmail(mockProfile, {})).toBe("user@example.com");
      expect(
        pickSamlEmail(mockProfile, { samlAttributeEmail: "customEmail" }),
      ).toBe("custom-email@example.com");
      expect(
        pickSamlEmail(
          {
            "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress":
              ["custom@example.com"],
          },
          {},
        ),
      ).toBe("custom@example.com");
    });

    it("pickSamlDisplayName extracts custom attribute, common names, or falls back to email", () => {
      expect(pickSamlDisplayName(mockProfile, {})).toBe("Jane Doe");
      expect(
        pickSamlDisplayName(mockProfile, { samlAttributeName: "customName" }),
      ).toBe("Custom User");
      expect(pickSamlDisplayName({ email: "user@example.com" }, {})).toBe(
        "user@example.com",
      );
      expect(
        pickSamlDisplayName({ givenName: "Alice", surname: "Smith" }, {}),
      ).toBe("Alice Smith");
    });
  });

  describe("Settings Repository Defaults", () => {
    it("mergeWithDefaults safely populates SAML defaults for existing installations", () => {
      const merged = mergeWithDefaults({ authMode: "password" });
      expect(merged.ssoType).toBe("oidc");
      expect(merged.samlIssuer).toBe("urn:9router:sp");
      expect(merged.samlLoginLabel).toBe("Sign in with SAML SSO");
      expect(merged.samlAttributeEmail).toBe("email");
      expect(merged.samlAttributeName).toBe("name");
    });
  });
});
