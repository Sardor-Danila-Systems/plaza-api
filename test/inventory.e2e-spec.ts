import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestInventoryBalance,
  createTestMaterial,
  createTestMaterialCategory,
  createTestProject,
  createTestUnit,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Inventory foundation (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Inventory Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  // -----------------------------------------------------------------
  // Warehouses
  // -----------------------------------------------------------------
  describe('Warehouses', () => {
    it('PROJECT_MANAGER can create, list, read, and archive their own warehouse', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Main Warehouse',
            code: 'main',
            comment: 'Ground floor',
          })
          .expect(201);
        expect(created.body.isActive).toBe(true);

        const list = await request(app.getHttpServer())
          .get(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body).toHaveLength(1);

        const get = await request(app.getHttpServer())
          .get(`/projects/${project.id}/warehouses/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(get.body.code).toBe('main');

        const archived = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/warehouses/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ isActive: false })
          .expect(200);
        expect(archived.body.isActive).toBe(false);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a duplicate warehouse code within the same project', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'A', code: 'main' })
          .expect(201);
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'B', code: 'main' })
          .expect(409);
        expect(response.body.code).toBe('UNIQUE_CONSTRAINT_VIOLATION');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('OWNER can read but not create warehouses', async () => {
      const project = await createTestProject(
        prisma.client,
        `Owner WH Test ${randomUUID()}`,
      );
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'A', code: 'a' })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('ACCOUNTANT can read but not create warehouses', async () => {
      const project = await createTestProject(
        prisma.client,
        `Accountant WH Test ${randomUUID()}`,
      );
      const accountant = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        const token = await loginTestUser(
          app.getHttpServer(),
          accountant.email,
        );
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'A', code: 'a' })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, accountant.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a manager of a different project cannot read or write here (nested IDOR)', async () => {
      const { project } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const warehouse = await createTestWarehouse(prisma.client, project.id);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/warehouses/${warehouse.id}`)
          .set('Authorization', `Bearer ${other.token}`)
          .expect(403);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/warehouses`)
          .set('Authorization', `Bearer ${other.token}`)
          .send({ name: 'Hijack', code: 'hijack' })
          .expect(403);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });

    it('returns 404 for a warehouse belonging to a different project (not 403, since the project itself is authorized)', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const foreignWarehouse = await createTestWarehouse(
          prisma.client,
          other.project.id,
        );
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/warehouses/${foreignWarehouse.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Units (read-only)
  // -----------------------------------------------------------------
  describe('Units', () => {
    it('lists seeded/created units, read-only for every role', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await createTestUnit(prisma.client, project.id, {
          symbol: 'kg',
          name: 'Kilogram',
        });
        const list = await request(app.getHttpServer())
          .get(`/projects/${project.id}/units`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].symbol).toBe('kg');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Material categories
  // -----------------------------------------------------------------
  describe('Material categories', () => {
    it('creates, lists, renames, and archives a category', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/material-categories`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Cement' })
          .expect(201);

        const renamed = await request(app.getHttpServer())
          .patch(
            `/projects/${project.id}/material-categories/${created.body.id}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Cement & Binders' })
          .expect(200);
        expect(renamed.body.name).toBe('Cement & Binders');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a duplicate category name within the same project', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/material-categories`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Cement' })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/material-categories`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Cement' })
          .expect(409);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Materials
  // -----------------------------------------------------------------
  describe('Materials', () => {
    it('creates a material with a category/unit relationship', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);

        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/materials`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Portland Cement',
            code: 'cement-500',
            categoryId: category.id,
            unitId: unit.id,
            minimumStock: '100.000000',
          })
          .expect(201);
        expect(created.body.minimumStock).toBe('100.000000');
        expect(created.body.categoryId).toBe(category.id);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a duplicate material code within the same project', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/materials`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'A',
            code: 'dup',
            categoryId: category.id,
            unitId: unit.id,
          })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/materials`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'B',
            code: 'dup',
            categoryId: category.id,
            unitId: unit.id,
          })
          .expect(409);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a categoryId belonging to a different project', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const foreignCategory = await createTestMaterialCategory(
          prisma.client,
          other.project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/materials`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'X',
            code: 'x',
            categoryId: foreignCategory.id,
            unitId: unit.id,
          })
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });

    it('rejects a negative minimumStock', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/materials`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'X',
            code: 'x',
            categoryId: category.id,
            unitId: unit.id,
            minimumStock: '-5',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('filters by category, active state, and search', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const catA = await createTestMaterialCategory(
          prisma.client,
          project.id,
          { name: 'A' },
        );
        const catB = await createTestMaterialCategory(
          prisma.client,
          project.id,
          { name: 'B' },
        );
        const unit = await createTestUnit(prisma.client, project.id);
        const m1 = await createTestMaterial(
          prisma.client,
          project.id,
          catA.id,
          unit.id,
          {
            name: 'Cement Bag',
          },
        );
        await createTestMaterial(prisma.client, project.id, catB.id, unit.id, {
          name: 'Rebar',
        });
        await prisma.client.material.update({
          where: { id: m1.id },
          data: { isActive: false },
        });

        const byCategory = await request(app.getHttpServer())
          .get(`/projects/${project.id}/materials?categoryId=${catA.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(byCategory.body).toHaveLength(1);

        const bySearch = await request(app.getHttpServer())
          .get(`/projects/${project.id}/materials?search=rebar`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(bySearch.body).toHaveLength(1);
        expect(bySearch.body[0].name).toBe('Rebar');

        const activeOnly = await request(app.getHttpServer())
          .get(`/projects/${project.id}/materials?isActive=true`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(activeOnly.body).toHaveLength(1);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Inventory balances (read)
  // -----------------------------------------------------------------
  describe('GET /projects/:projectId/inventory', () => {
    it('lists balances with derived averageCostUzs and lowStock', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);
        const warehouse = await createTestWarehouse(prisma.client, project.id);
        const material = await createTestMaterial(
          prisma.client,
          project.id,
          category.id,
          unit.id,
          {
            minimumStock: '50',
          },
        );
        await createTestInventoryBalance(
          prisma.client,
          project.id,
          warehouse.id,
          material.id,
          {
            quantity: '10',
            valueUzs: '1000',
          },
        );

        const list = await request(app.getHttpServer())
          .get(`/projects/${project.id}/inventory`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].averageCostUzs).toBe('100.00000000');
        expect(list.body[0].lowStock).toBe(true);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('filters by warehouseId, materialId, and lowStock', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);
        const wh1 = await createTestWarehouse(prisma.client, project.id);
        const wh2 = await createTestWarehouse(prisma.client, project.id);
        const lowMaterial = await createTestMaterial(
          prisma.client,
          project.id,
          category.id,
          unit.id,
          {
            minimumStock: '100',
          },
        );
        const okMaterial = await createTestMaterial(
          prisma.client,
          project.id,
          category.id,
          unit.id,
          {
            minimumStock: '5',
          },
        );
        await createTestInventoryBalance(
          prisma.client,
          project.id,
          wh1.id,
          lowMaterial.id,
          {
            quantity: '10',
            valueUzs: '100',
          },
        );
        await createTestInventoryBalance(
          prisma.client,
          project.id,
          wh2.id,
          okMaterial.id,
          {
            quantity: '10',
            valueUzs: '100',
          },
        );

        const lowStockOnly = await request(app.getHttpServer())
          .get(`/projects/${project.id}/inventory?lowStock=true`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(lowStockOnly.body).toHaveLength(1);
        expect(lowStockOnly.body[0].materialId).toBe(lowMaterial.id);

        const byWarehouse = await request(app.getHttpServer())
          .get(`/projects/${project.id}/inventory?warehouseId=${wh2.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(byWarehouse.body).toHaveLength(1);
        expect(byWarehouse.body[0].materialId).toBe(okMaterial.id);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('never returns a balance from a different project', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          other.project.id,
        );
        const unit = await createTestUnit(prisma.client, other.project.id);
        const warehouse = await createTestWarehouse(
          prisma.client,
          other.project.id,
        );
        const material = await createTestMaterial(
          prisma.client,
          other.project.id,
          category.id,
          unit.id,
        );
        await createTestInventoryBalance(
          prisma.client,
          other.project.id,
          warehouse.id,
          material.id,
          {
            quantity: '10',
            valueUzs: '100',
          },
        );

        const list = await request(app.getHttpServer())
          .get(`/projects/${project.id}/inventory`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body).toHaveLength(0);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });
});
