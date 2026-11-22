import { ObjectId } from "mongodb";
import { hashPassword } from "./passwords.js";

function cloneValue(val) {
  if (val === null || typeof val !== "object") return val;
  if (val instanceof ObjectId) return new ObjectId(val.toString());
  if (val instanceof Date) return new Date(val.getTime());
  if (Array.isArray(val)) return val.map(cloneValue);
  const out = {};
  for (const [k, v] of Object.entries(val)) out[k] = cloneValue(v);
  return out;
}

function equalsValue(a, b) {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function compareValues(a, b) {
  const va = a instanceof Date ? a.getTime() : a;
  const vb = b instanceof Date ? b.getTime() : b;
  if (va < vb) return -1;
  if (va > vb) return 1;
  return 0;
}

function getByPath(obj, path) {
  const parts = path.split(".");
  let current = [obj];
  let isMulti = false;
  for (const part of parts) {
    const next = [];
    for (const item of current) {
      if (item === null || item === undefined || typeof item !== "object") continue;
      if (Array.isArray(item)) {
        isMulti = true;
        for (const el of item) {
          if (el && typeof el === "object" && part in el) next.push(el[part]);
        }
      } else if (part in item) {
        const val = item[part];
        if (Array.isArray(val)) {
          isMulti = true;
          next.push(...val);
        } else {
          next.push(val);
        }
      }
    }
    current = next;
  }
  if (!isMulti) return current.length ? current[0] : undefined;
  return { __multi: true, values: current };
}

function getDirectPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = cloneValue(value);
}

function unsetByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

function evalExpr(expr, doc, vars = {}) {
  if (expr === null || expr === undefined || typeof expr !== "object") {
    if (typeof expr === "string") {
      if (expr.startsWith("$$")) {
        const [varName, ...rest] = expr.slice(2).split(".");
        let val = vars[varName];
        for (const p of rest) {
          if (val === null || val === undefined) return undefined;
          val = val[p];
        }
        return val;
      }
      if (expr.startsWith("$")) {
        return getDirectPath(doc, expr.slice(1));
      }
    }
    return expr;
  }
  if (expr instanceof ObjectId || expr instanceof Date) return expr;
  if (Array.isArray(expr)) return expr.map((item) => evalExpr(item, doc, vars));
  if ("$literal" in expr) return cloneValue(expr.$literal);
  if ("$ifNull" in expr) {
    const [a, b] = expr.$ifNull;
    const va = evalExpr(a, doc, vars);
    return va !== undefined && va !== null ? va : evalExpr(b, doc, vars);
  }
  if ("$eq" in expr) {
    const [a, b] = expr.$eq;
    return equalsValue(evalExpr(a, doc, vars), evalExpr(b, doc, vars));
  }
  if ("$ne" in expr) {
    const [a, b] = expr.$ne;
    return !equalsValue(evalExpr(a, doc, vars), evalExpr(b, doc, vars));
  }
  if ("$lte" in expr) {
    const [a, b] = expr.$lte;
    return compareValues(evalExpr(a, doc, vars), evalExpr(b, doc, vars)) <= 0;
  }
  if ("$lt" in expr) {
    const [a, b] = expr.$lt;
    return compareValues(evalExpr(a, doc, vars), evalExpr(b, doc, vars)) < 0;
  }
  if ("$gte" in expr) {
    const [a, b] = expr.$gte;
    return compareValues(evalExpr(a, doc, vars), evalExpr(b, doc, vars)) >= 0;
  }
  if ("$gt" in expr) {
    const [a, b] = expr.$gt;
    return compareValues(evalExpr(a, doc, vars), evalExpr(b, doc, vars)) > 0;
  }
  if ("$add" in expr) {
    return expr.$add.reduce((sum, item) => sum + Number(evalExpr(item, doc, vars) ?? 0), 0);
  }
  if ("$subtract" in expr) {
    const [a, b] = expr.$subtract;
    return Number(evalExpr(a, doc, vars) ?? 0) - Number(evalExpr(b, doc, vars) ?? 0);
  }
  if ("$and" in expr) {
    return expr.$and.every((item) => Boolean(evalExpr(item, doc, vars)));
  }
  if ("$or" in expr) {
    return expr.$or.some((item) => Boolean(evalExpr(item, doc, vars)));
  }
  if ("$cond" in expr) {
    const [cond, t, f] = expr.$cond;
    return evalExpr(cond, doc, vars) ? evalExpr(t, doc, vars) : evalExpr(f, doc, vars);
  }
  if ("$toString" in expr) {
    const v = evalExpr(expr.$toString, doc, vars);
    return v instanceof ObjectId ? v.toString() : String(v ?? "");
  }
  if ("$regexMatch" in expr) {
    const input = String(evalExpr(expr.$regexMatch.input, doc, vars) ?? "");
    const pattern = String(evalExpr(expr.$regexMatch.regex, doc, vars) ?? "");
    const options = expr.$regexMatch.options ?? "";
    return new RegExp(pattern, options).test(input);
  }
  if ("$map" in expr) {
    const arr = evalExpr(expr.$map.input, doc, vars) ?? [];
    const asName = expr.$map.as ?? "this";
    return arr.map((el) => evalExpr(expr.$map.in, doc, { ...vars, [asName]: el }));
  }
  if ("$filter" in expr) {
    const arr = evalExpr(expr.$filter.input, doc, vars) ?? [];
    const asName = expr.$filter.as ?? "this";
    return arr.filter((el) => Boolean(evalExpr(expr.$filter.cond, doc, { ...vars, [asName]: el })));
  }
  if ("$anyElementTrue" in expr) {
    const raw = Array.isArray(expr.$anyElementTrue) ? expr.$anyElementTrue[0] : expr.$anyElementTrue;
    const arr = evalExpr(raw, doc, vars) ?? [];
    return arr.some(Boolean);
  }
  if ("$allElementsTrue" in expr) {
    const raw = Array.isArray(expr.$allElementsTrue) ? expr.$allElementsTrue[0] : expr.$allElementsTrue;
    const arr = evalExpr(raw, doc, vars) ?? [];
    return arr.every(Boolean);
  }
  if ("$arrayElemAt" in expr) {
    const [arrExpr, idxExpr] = expr.$arrayElemAt;
    const arr = evalExpr(arrExpr, doc, vars);
    const idx = evalExpr(idxExpr, doc, vars);
    return Array.isArray(arr) ? arr[idx] : undefined;
  }
  if ("$let" in expr) {
    const nextVars = { ...vars };
    for (const [k, v] of Object.entries(expr.$let.vars ?? {})) {
      nextVars[k] = evalExpr(v, doc, vars);
    }
    return evalExpr(expr.$let.in, doc, nextVars);
  }
  if ("$mergeObjects" in expr) {
    const objs = expr.$mergeObjects.map((o) => evalExpr(o, doc, vars) ?? {});
    return Object.assign({}, ...objs);
  }
  if ("$concatArrays" in expr) {
    const arrs = expr.$concatArrays.map((a) => evalExpr(a, doc, vars) ?? []);
    return [].concat(...arrs);
  }

  const out = {};
  for (const [k, v] of Object.entries(expr)) {
    out[k] = evalExpr(v, doc, vars);
  }
  return out;
}

function isOperatorObject(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  if (val instanceof ObjectId || val instanceof Date || val instanceof RegExp) return false;
  return Object.keys(val).some((k) => k.startsWith("$"));
}

function matchesSingleValue(val, cond) {
  if (!isOperatorObject(cond)) {
    return equalsValue(val, cond);
  }
  for (const [op, target] of Object.entries(cond)) {
    if (op === "$options") continue;
    if (op === "$ne") {
      if (equalsValue(val, target)) return false;
    } else if (op === "$exists") {
      const exists = val !== undefined;
      if (Boolean(target) !== exists) return false;
    } else if (op === "$in") {
      if (!Array.isArray(target) || !target.some((item) => equalsValue(val, item))) return false;
    } else if (op === "$gt") {
      if (val === undefined || val === null || compareValues(val, target) <= 0) return false;
    } else if (op === "$gte") {
      if (val === undefined || val === null || compareValues(val, target) < 0) return false;
    } else if (op === "$lt") {
      if (val === undefined || val === null || compareValues(val, target) >= 0) return false;
    } else if (op === "$lte") {
      if (val === undefined || val === null || compareValues(val, target) > 0) return false;
    } else if (op === "$regex") {
      if (val === undefined || val === null) return false;
      const re = target instanceof RegExp ? target : new RegExp(target, cond.$options ?? "");
      if (!re.test(String(val))) return false;
    }
  }
  return true;
}

function matchesFilter(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!Array.isArray(cond) || !cond.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === "$and") {
      if (!Array.isArray(cond) || !cond.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === "$expr") {
      if (!evalExpr(cond, doc, {})) return false;
      continue;
    }
    const raw = getByPath(doc, key);
    if (raw && typeof raw === "object" && raw.__multi) {
      if (isOperatorObject(cond) && "$exists" in cond) {
        const exists = raw.values.length > 0;
        if (Boolean(cond.$exists) !== exists) return false;
        const rest = { ...cond };
        delete rest.$exists;
        if (Object.keys(rest).length && !raw.values.some((v) => matchesSingleValue(v, rest))) return false;
      } else if (!raw.values.some((v) => matchesSingleValue(v, cond))) {
        return false;
      }
    } else if (!matchesSingleValue(raw, cond)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  if (Array.isArray(update)) {
    for (const stage of update) {
      if (stage.$set) {
        for (const [k, expr] of Object.entries(stage.$set)) {
          setByPath(doc, k, evalExpr(expr, doc, {}));
        }
      }
    }
    return doc;
  }
  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      setByPath(doc, k, v);
    }
  }
  if (update.$inc) {
    for (const [k, delta] of Object.entries(update.$inc)) {
      const cur = Number(getDirectPath(doc, k) ?? 0);
      setByPath(doc, k, cur + Number(delta));
    }
  }
  if (update.$unset) {
    for (const k of Object.keys(update.$unset)) {
      unsetByPath(doc, k);
    }
  }
  return doc;
}

function applyProjection(doc, projection) {
  if (!projection) return cloneValue(doc);
  const out = { _id: cloneValue(doc._id) };
  for (const [k, include] of Object.entries(projection)) {
    if (include && k in doc) out[k] = cloneValue(doc[k]);
  }
  return out;
}

class MockCursor {
  constructor(docs, projection) {
    this._docs = docs;
    this._projection = projection;
    this._sort = null;
    this._limit = null;
  }

  sort(spec) {
    this._sort = spec;
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  async toArray() {
    let items = [...this._docs];
    if (this._sort) {
      const entries = Object.entries(this._sort);
      items.sort((a, b) => {
        for (const [field, dir] of entries) {
          const va = getDirectPath(a, field);
          const vb = getDirectPath(b, field);
          const cmp = compareValues(va ?? "", vb ?? "");
          if (cmp !== 0) return cmp * dir;
        }
        return 0;
      });
    }
    if (this._limit !== null && this._limit !== undefined) {
      items = items.slice(0, this._limit);
    }
    return items.map((doc) => applyProjection(doc, this._projection));
  }
}

class MockAggregateCursor {
  constructor(docs, pipeline) {
    this._docs = docs;
    this._pipeline = pipeline;
  }

  _run() {
    let rows = this._docs.map(cloneValue);
    for (const stage of this._pipeline) {
      if (stage.$match) {
        rows = rows.filter((doc) => matchesFilter(doc, stage.$match));
      } else if (stage.$unwind) {
        const path = typeof stage.$unwind === "string"
          ? stage.$unwind.replace(/^\$/, "")
          : stage.$unwind.path.replace(/^\$/, "");
        const unwound = [];
        for (const doc of rows) {
          const arr = getDirectPath(doc, path);
          if (Array.isArray(arr) && arr.length) {
            for (const el of arr) {
              const copy = cloneValue(doc);
              setByPath(copy, path, el);
              unwound.push(copy);
            }
          }
        }
        rows = unwound;
      } else if (stage.$addFields) {
        for (const doc of rows) {
          for (const [k, expr] of Object.entries(stage.$addFields)) {
            setByPath(doc, k, evalExpr(expr, doc, {}));
          }
        }
      } else if (stage.$group) {
        const groups = new Map();
        const { _id: idExpr, ...accumulators } = stage.$group;
        for (const doc of rows) {
          const groupId = idExpr === null ? null : evalExpr(idExpr, doc, {});
          const key = groupId instanceof ObjectId ? `oid:${groupId.toString()}` : JSON.stringify(groupId);
          let group = groups.get(key);
          if (!group) {
            group = { _id: cloneValue(groupId) };
            for (const field of Object.keys(accumulators)) group[field] = 0;
            groups.set(key, group);
          }
          for (const [field, acc] of Object.entries(accumulators)) {
            if ("$sum" in acc) {
              const inc = acc.$sum === 1 ? 1 : Number(evalExpr(acc.$sum, doc, {}) ?? 0);
              group[field] += inc;
            }
          }
        }
        rows = [...groups.values()];
      }
    }
    return rows;
  }

  async toArray() {
    return this._run();
  }

  async next() {
    return this._run()[0] ?? null;
  }
}

class MockCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.uniqueIndexes = [];
  }

  _checkUnique(candidate, ignoreDoc = null) {
    for (const index of this.uniqueIndexes) {
      if (index.partialFilterExpression && !matchesFilter(candidate, index.partialFilterExpression)) {
        continue;
      }
      const keyFields = Object.keys(index.keys);
      const conflict = this.docs.find((existing) => {
        if (ignoreDoc && existing === ignoreDoc) return false;
        if (index.partialFilterExpression && !matchesFilter(existing, index.partialFilterExpression)) {
          return false;
        }
        return keyFields.every((f) => equalsValue(getDirectPath(existing, f), getDirectPath(candidate, f)));
      });
      if (conflict) {
        const err = new Error(`E11000 duplicate key error on ${this.name}`);
        err.code = 11000;
        throw err;
      }
    }
  }

  async indexes() {
    return [];
  }

  async dropIndex() {
    return {};
  }

  async createIndex(keys, options = {}) {
    if (options.unique) {
      this.uniqueIndexes.push({
        keys,
        partialFilterExpression: options.partialFilterExpression ?? null,
      });
    }
    return "ok";
  }

  find(filter = {}, options = {}) {
    const matched = this.docs.filter((doc) => matchesFilter(doc, filter));
    return new MockCursor(matched, options.projection);
  }

  async findOne(filter = {}, options = {}) {
    const doc = this.docs.find((item) => matchesFilter(item, filter));
    return doc ? applyProjection(doc, options.projection) : null;
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }

  async insertOne(doc) {
    const copy = cloneValue(doc);
    if (copy._id === undefined) copy._id = new ObjectId();
    this._checkUnique(copy);
    this.docs.push(copy);
    return { insertedId: cloneValue(copy._id) };
  }

  async updateOne(filter, update) {
    const doc = this.docs.find((item) => matchesFilter(item, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    const candidate = applyUpdate(cloneValue(doc), update);
    this._checkUnique(candidate, doc);
    Object.keys(doc).forEach((k) => delete doc[k]);
    Object.assign(doc, candidate);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter) {
    const idx = this.docs.findIndex((item) => matchesFilter(item, filter));
    if (idx === -1) return { deletedCount: 0 };
    this.docs.splice(idx, 1);
    return { deletedCount: 1 };
  }

  async deleteMany(filter) {
    const before = this.docs.length;
    this.docs = this.docs.filter((item) => !matchesFilter(item, filter));
    return { deletedCount: before - this.docs.length };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    let doc = this.docs.find((item) => matchesFilter(item, filter));
    if (!doc) {
      if (!options.upsert) return null;
      doc = {};
      if (filter._id !== undefined) doc._id = cloneValue(filter._id);
      else doc._id = new ObjectId();
      for (const [k, v] of Object.entries(filter)) {
        if (!k.startsWith("$") && !isOperatorObject(v)) doc[k] = cloneValue(v);
      }
      const candidate = applyUpdate(doc, update);
      this._checkUnique(candidate);
      this.docs.push(candidate);
      return cloneValue(candidate);
    }
    const before = cloneValue(doc);
    const candidate = applyUpdate(cloneValue(doc), update);
    this._checkUnique(candidate, doc);
    Object.keys(doc).forEach((k) => delete doc[k]);
    Object.assign(doc, candidate);
    return options.returnDocument === "after" ? cloneValue(doc) : before;
  }

  aggregate(pipeline) {
    return new MockAggregateCursor(this.docs, pipeline);
  }
}

export async function createMockDatabase() {
  const collections = new Map();
  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new MockCollection(name));
    return collections.get(name);
  };

  // Seed a primary store, owner account, and sample products so the app is usable out of the box
  const stores = getCollection("stores");
  const users = getCollection("users");
  const products = getCollection("products");
  const stockMovements = getCollection("stockMovements");
  const counters = getCollection("counters");

  const primaryStoreId = new ObjectId();
  const ownerUserId = new ObjectId();
  const now = new Date();

  await stores.insertOne({
    _id: primaryStoreId,
    name: "Toko Berkah 1",
    isPrimary: true,
    active: true,
    createdAt: now,
  });

  await users.insertOne({
    _id: ownerUserId,
    email: "owner@toko.com",
    passwordHash: await hashPassword("kasirku123456"),
    role: "owner",
    storeId: primaryStoreId,
    active: true,
    sessionVersion: 0,
    createdAt: now,
  });

  const sampleProducts = [
    { name: "Kopi Susu Gula Aren", category: "Minuman", price: 18000, stock: 35, lowStockThreshold: 5, barcode: "2000000000015" },
    { name: "Roti Bakar Cokelat", category: "Makanan", price: 15000, stock: 24, lowStockThreshold: 5, barcode: "2000000000022" },
    { name: "Air Mineral 600ml", category: "Minuman", price: 5000, stock: 60, lowStockThreshold: 10, barcode: "2000000000039" },
    { name: "Keripik Kentang Original", category: "Snack", price: 12000, stock: 4, lowStockThreshold: 5, barcode: "2000000000046" },
    { name: "Teh Hijau Botol", category: "Minuman", price: 8000, stock: 40, lowStockThreshold: 8, barcode: "2000000000053" },
  ];

  for (const item of sampleProducts) {
    const productResult = await products.insertOne({
      storeId: primaryStoreId,
      ...item,
      createdAt: now,
    });
    await stockMovements.insertOne({
      storeId: primaryStoreId,
      productId: productResult.insertedId,
      productName: item.name,
      type: "initial",
      quantity: item.stock,
      stockBefore: 0,
      stockAfter: item.stock,
      reason: "Stok awal produk",
      createdBy: ownerUserId,
      createdAt: now,
    });
  }

  await counters.insertOne({
    _id: "internal_barcode_seq",
    value: sampleProducts.length,
  });

  return {
    collection: getCollection,
  };
}
