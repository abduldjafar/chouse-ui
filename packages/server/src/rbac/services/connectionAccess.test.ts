/**
 * Regression: a connection-scoped data access policy attached to a role must make
 * that connection visible to users with the role (via getUserConnections).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "crypto";

process.env.RBAC_DB_TYPE = "sqlite";
process.env.RBAC_SQLITE_PATH = ":memory:";

const { initializeDatabase, closeDatabase, getDatabase, getSchema } = await import("../db");
const { runMigrations } = await import("../db/migrations");
const { seedDatabase } = await import("./seed");
const { createPolicy, setPoliciesForRole } = await import("./dataAccessPolicies");
const { createRole, createUser } = await import("./rbac");
const { getUserConnections } = await import("./connections");
const { eq } = await import("drizzle-orm");

let connId = "";

beforeAll(async () => {
  await initializeDatabase();
  await runMigrations({ skipSeed: true });
  await seedDatabase();

  const db = getDatabase() as any;
  const schema = getSchema();
  connId = randomUUID();
  await db.insert(schema.clickhouseConnections).values({
    id: connId, name: "prod", host: "localhost", port: 8123, username: "default",
    passwordEncrypted: "x", database: "default", isDefault: true, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
});

afterAll(async () => { await closeDatabase(); });

describe("connection access via role policy", () => {
  it("grants a connection-scoped policy's connection to users of the role", async () => {
    // Need a permission id for createRole (requires >=1).
    const db = getDatabase() as any;
    const schema = getSchema();
    const perm = (await db.select().from(schema.permissions).where(eq(schema.permissions.name, "database:view")).limit(1))[0];

    const policy = await createPolicy({
      name: "Prod analytics",
      rules: [{ connectionId: connId, databasePattern: "*", tablePattern: "*", isAllowed: true, priority: 0 }],
    });

    const role = await createRole({
      name: "prod_reader",
      displayName: "Prod Reader",
      permissionIds: [perm.id],
      dataAccessPolicyIds: [policy.id],
    });

    // Sanity: the policy is linked to the role.
    const linkedPolicyIds = (await db.select().from(schema.roleDataAccessPolicies).where(eq(schema.roleDataAccessPolicies.roleId, role.id))).map((l: any) => l.policyId);
    expect(linkedPolicyIds).toContain(policy.id);

    const user = await createUser({ email: "u@test.local", username: "u", password: "Password123!", roleIds: [role.id] });

    const conns = await getUserConnections(user.id);
    expect(conns.map((c) => c.id)).toContain(connId);
  });

  it("does NOT grant a connection from a global (null) rule alone", async () => {
    // A null-connection rule is a global db/table scope; by itself it grants no
    // connection. Connection access requires a connection-scoped allow rule.
    const db = getDatabase() as any;
    const schema = getSchema();
    const perm = (await db.select().from(schema.permissions).where(eq(schema.permissions.name, "database:view")).limit(1))[0];

    const policy = await createPolicy({
      name: "Global reader",
      rules: [{ connectionId: null, databasePattern: "*", tablePattern: "*", isAllowed: true, priority: 0 }],
    });
    const role = await createRole({ name: "global_reader", displayName: "Global", permissionIds: [perm.id], dataAccessPolicyIds: [policy.id] });
    const user = await createUser({ email: "g@test.local", username: "g", password: "Password123!", roleIds: [role.id] });

    const conns = await getUserConnections(user.id);
    expect(conns.map((c) => c.id)).not.toContain(connId);
  });
});
