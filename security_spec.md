# Security Specification — KasirKu Firestore Rules

## 1. Data Invariants
1. **User Profile Isolation (`/users/{userId}`)**: A user profile may only be read, created, or updated by the authenticated user whose `request.auth.uid == userId` (with verified email), or by the bootstrapped admin. Users cannot forge `uid`, assign themselves admin privileges, or read another user's email/PII.
2. **Store Ownership & Membership (`/stores/{storeId}`)**: A store document must always be created with `ownerUid == request.auth.uid`, `memberUids` containing `request.auth.uid`, and server timestamps. Only the store owner (or admin) can change `name`, `active`, `branchEmail`, or `memberUids`. An invited branch user whose verified email matches `branchEmail` may read the store and join `memberUids`.
3. **Subcollection Master Gate (`/stores/{storeId}/...`)**: Every product, shift, sale, sale return, stock movement, and scanner session must reference an existing parent store (`exists(/stores/$(storeId))`), match the parent store's `ownerUid`, and restrict operations to verified store members (`request.auth.uid in parentStore.memberUids`).
4. **Immutable Audit & Identity Fields**: `ownerUid`, `storeId`, `createdAt`, `openedAt`, `cashierUid`, and `createdByUid` cannot be modified after creation.
5. **Terminal State Locking**: Closed shifts (`status == 'closed'`) and fully returned sales (`status == 'returned'`) cannot be mutated by non-admin users.
6. **Zero Unverified or Unauthenticated Access**: Every rule requires `request.auth != null && request.auth.token.email_verified == true`. No `get()` or `exists()` calls are placed inside `allow list`.

## 2. The "Dirty Dozen" Payloads
1. **Unauthenticated read/write** (`auth: null`) on `/stores/store-1/products/prod-1` -> `PERMISSION_DENIED`.
2. **Unverified email write** (`email_verified: false`) creating `/stores/store-1` -> `PERMISSION_DENIED`.
3. **Cross-user PII read** (`uid: "user-b"` reading `/users/user-a`) -> `PERMISSION_DENIED`.
4. **UID Spoofing on User Create** (`/users/user-a` with `uid: "user-b"`) -> `PERMISSION_DENIED`.
5. **Ghost Field / Shadow Update** (`isAdmin: true` or `extraField: 123` on `/stores/store-1` or `/stores/store-1/products/prod-1`) -> `PERMISSION_DENIED`.
6. **ID Poisoning** (1,500-char document ID or invalid characters `../admin` on `/stores/.../products/...`) -> `PERMISSION_DENIED`.
7. **Orphaned Subcollection Record** (creating a product under non-existent `/stores/missing-store/products/p1`) -> `PERMISSION_DENIED`.
8. **Cross-Tenant Product Tampering** (`user-b` updating `/stores/store-a/products/p1`) -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery** (`createdAt: new Date(2020, 0, 1)` instead of `request.time`) -> `PERMISSION_DENIED`.
10. **Terminal State Bypass** (non-admin updating a `closed` shift back to `open`, or mutating a `returned` sale) -> `PERMISSION_DENIED`.
11. **Array / String Resource Exhaustion** (`name` > 120 chars, `items` > 100 entries, or `memberUids` > 10 entries) -> `PERMISSION_DENIED`.
12. **Blanket List Query** (listing `/stores/store-a/sales` without constraining to `memberUids` / `ownerUid` matching `request.auth.uid`) -> `PERMISSION_DENIED`.
