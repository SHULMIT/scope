// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillRevisionStore } from './skill-revision-store.js';
import type { SkillRevisionDocument } from '../types/skill.js';

/** Project scope used across these unit tests. */
const PID = 'proj-test';

/** Build a full SkillRevisionDocument with required defaults */
function makeRevDoc(overrides: Partial<SkillRevisionDocument> & Pick<SkillRevisionDocument, '_id' | 'ref' | 'source' | 'skillName' | 'commitHash' | 'name' | 'content'>): SkillRevisionDocument {
  return {
    projectId: PID,
    skillPath: `skills/${overrides.skillName}`,
    commitTimestamp: new Date(),
    description: 'test description',
    archiveUrl: 'https://blob.test/archive.tar.gz',
    resolvedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

/** Create a mock MongoDB collection with chainable find/sort/limit/toArray */
function makeMockCollection() {
  const store = new Map<string, SkillRevisionDocument>();
  const toArrayResult: SkillRevisionDocument[] = [];

  const matches = (doc: SkillRevisionDocument, filter: any): boolean => {
    if (filter._id !== undefined && doc._id !== filter._id) return false;
    if (filter.projectId !== undefined && doc.projectId !== filter.projectId) return false;
    if (filter.ref !== undefined && doc.ref !== filter.ref) return false;
    return true;
  };

  const mockChain = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockImplementation(() => Promise.resolve(toArrayResult)),
  };

  return {
    findOne: vi.fn().mockImplementation(async (filter: any) => {
      for (const doc of store.values()) {
        if (matches(doc, filter)) return doc;
      }
      return null;
    }),
    find: vi.fn().mockReturnValue(mockChain),
    insertOne: vi.fn().mockImplementation(async (doc: any) => {
      store.set(doc._id, doc);
      return { insertedId: doc._id };
    }),
    deleteMany: vi.fn().mockImplementation(async () => ({ deletedCount: 0 })),
    _store: store,
    _chain: mockChain,
    _toArrayResult: toArrayResult,
  };
}

describe('SkillRevisionStore', () => {
  let mockCol: ReturnType<typeof makeMockCollection>;
  let revStore: SkillRevisionStore;

  beforeEach(() => {
    mockCol = makeMockCollection();
    revStore = new SkillRevisionStore(mockCol as any);
  });

  describe('get', () => {
    it('returns null for non-existent ID', async () => {
      const result = await revStore.get('non-existent');
      expect(result).toBeNull();
    });

    it('returns document when found', async () => {
      const doc = makeRevDoc({
        _id: 'test-id',
        ref: 'owner/repo/skill@abc123',
        source: 'owner/repo',
        skillName: 'skill',
        commitHash: 'abc123',
        name: 'Test',
        content: '# SKILL.md',
      });
      mockCol._store.set('test-id', doc);
      const result = await revStore.get('test-id');
      expect(result).toEqual(doc);
    });
  });

  describe('getByRef', () => {
    it('looks up by project + ref', async () => {
      const ref = 'owner/repo/skill@abc123';
      const doc = makeRevDoc({
        _id: 'uuid-1',
        ref,
        source: 'owner/repo',
        skillName: 'skill',
        commitHash: 'abc123',
        name: 'Test',
        content: '# content',
      });
      mockCol._store.set('uuid-1', doc);
      const result = await revStore.getByRef(PID, ref);
      expect(result).toEqual(doc);
    });

    it('does not find another project\'s ref', async () => {
      const ref = 'owner/repo/skill@abc123';
      mockCol._store.set('uuid-1', makeRevDoc({
        _id: 'uuid-1',
        projectId: 'project-a',
        ref,
        source: 'owner/repo',
        skillName: 'skill',
        commitHash: 'abc123',
        name: 'Test',
        content: '# content',
      }));
      const result = await revStore.getByRef('project-b', ref);
      expect(result).toBeNull();
    });
  });

  describe('findOrCreate', () => {
    const inputDoc = {
      projectId: PID,
      ref: 'owner/repo/skill@abc123',
      source: 'owner/repo',
      skillName: 'skill',
      skillPath: 'skills/skill',
      commitHash: 'abc123',
      commitTimestamp: new Date(),
      name: 'Test Skill',
      description: 'test',
      content: '# content',
      archiveUrl: 'https://blob.test/archive.tar.gz',
      resolvedAt: new Date(),
    };

    it('creates a new document with a fresh UUID when it does not exist', async () => {
      const result = await revStore.findOrCreate(inputDoc);
      expect(result._id).toBeTruthy();
      expect(result.ref).toBe(inputDoc.ref);
      expect(result.projectId).toBe(PID);
      expect(result.name).toBe('Test Skill');
      expect(result.content).toBe('# content');
      expect(mockCol.insertOne).toHaveBeenCalledOnce();
    });

    it('returns existing document without inserting', async () => {
      const existing = makeRevDoc({ ...inputDoc, _id: 'uuid-existing' });
      mockCol._store.set('uuid-existing', existing);

      const result = await revStore.findOrCreate(inputDoc);
      expect(result).toEqual(existing);
      expect(mockCol.insertOne).not.toHaveBeenCalled();
    });

    it('is idempotent within a project — same ref returns same doc', async () => {
      const r1 = await revStore.findOrCreate(inputDoc);
      const r2 = await revStore.findOrCreate(inputDoc);
      expect(r1._id).toBe(r2._id);
      expect(mockCol.insertOne).toHaveBeenCalledOnce();
    });

    it('creates distinct per-project copies for the same ref', async () => {
      const a = await revStore.findOrCreate({ ...inputDoc, projectId: 'project-a' });
      const b = await revStore.findOrCreate({ ...inputDoc, projectId: 'project-b' });
      expect(a.ref).toBe(b.ref);
      expect(a._id).not.toBe(b._id);
      expect(mockCol.insertOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('listBySkill', () => {
    it('calls find with project, source and skillName', async () => {
      await revStore.listBySkill(PID, 'owner/repo', 'my-skill');
      expect(mockCol.find).toHaveBeenCalledWith({ projectId: PID, source: 'owner/repo', skillName: 'my-skill' });
      expect(mockCol._chain.sort).toHaveBeenCalledWith({ resolvedAt: -1 });
      expect(mockCol._chain.limit).toHaveBeenCalledWith(20);
    });

    it('respects custom limit', async () => {
      await revStore.listBySkill(PID, 'a', 'b', { limit: 5 });
      expect(mockCol._chain.limit).toHaveBeenCalledWith(5);
    });
  });

  describe('getByRefs', () => {
    it('returns empty array for empty refs', async () => {
      const result = await revStore.getByRefs(PID, []);
      expect(result).toEqual([]);
      expect(mockCol.find).not.toHaveBeenCalled();
    });

    it('queries by project + refs', async () => {
      const refs = ['owner/repo/s1@abc', 'owner/repo/s2@def'];

      await revStore.getByRefs(PID, refs);
      expect(mockCol.find).toHaveBeenCalledWith({ projectId: PID, ref: { $in: refs } });
    });
  });

  describe('deleteBySkill', () => {
    it('deletes by project, source and skillName', async () => {
      await revStore.deleteBySkill(PID, 'owner/repo', 'my-skill');
      expect(mockCol.deleteMany).toHaveBeenCalledWith({ projectId: PID, source: 'owner/repo', skillName: 'my-skill' });
    });
  });
});
