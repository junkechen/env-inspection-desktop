import { api } from '../api.js';

export default {
  template: `
  <div>
    <h2 class="page-title">部门 / 车间管理</h2>
    <p class="page-sub">维护组织架构，与移动端数据同源</p>

    <div class="toolbar">
      <span class="spacer"></span>
      <el-button type="success" :icon="Plus" @click="openCreate">新增部门</el-button>
    </div>

    <div class="card">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="description" label="说明" min-width="220" show-overflow-tooltip />
        <el-table-column prop="createdAt" label="创建日期" width="130" />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{row}">
            <el-button text type="primary" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑部门' : '新增部门'" width="420px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.description" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, reactive } = Vue;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const { Plus, Edit, Delete } = ElementPlusIconsVue;

    const list = ref([]);
    const loading = ref(false);
    const dialogVisible = ref(false);
    const editing = ref(false);
    const saving = ref(false);
    const editingId = ref(null);
    const form = reactive({ name: '', description: '' });

    async function load() {
      loading.value = true;
      try { list.value = await api.departments(); }
      finally { loading.value = false; }
    }
    function openCreate() {
      editing.value = false; editingId.value = null;
      Object.assign(form, { name: '', description: '' });
      dialogVisible.value = true;
    }
    function openEdit(row) {
      editing.value = true; editingId.value = row._id;
      Object.assign(form, { name: row.name, description: row.description });
      dialogVisible.value = true;
    }
    async function save() {
      if (!form.name) { ElMessage.warning('请填写名称'); return; }
      saving.value = true;
      try {
        if (editing.value) await api.updateDept(editingId.value, { ...form });
        else await api.createDept({ ...form });
        ElMessage.success('已保存');
        dialogVisible.value = false;
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    async function remove(row) {
      try { await ElMessageBox.confirm('确认删除该部门？', '提示', { type: 'warning' }); }
      catch (e) { return; }
      try { await api.deleteDept(row._id); ElMessage.success('已删除'); load(); }
      catch (e) { ElMessage.error(e.message); }
    }

    load();
    return { list, loading, dialogVisible, editing, saving, form, openCreate, openEdit, save, remove, Plus, Edit, Delete };
  }
};
