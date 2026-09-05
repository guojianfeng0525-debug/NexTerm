// 验证受限 PATH 环境下的 find_java 行为（模拟 GUI 应用启动）。
#[cfg(not(windows))]
use nexterm_lib::decompile;
#[test]
// macOS/Linux 提供 PATH 无关的 /usr/bin/java 兜底，因此清空环境后仍可恢复。
// Windows 默认没有系统 Java；真实 GUI 启动会继承用户 PATH，本测试模拟的
// “无 PATH 且无 JAVA_HOME”状态按设计不可恢复，所以在 Windows 跳过。
#[cfg(not(windows))]
fn find_java_gui_env() {
    // 保存并清空 PATH/JAVA_HOME，模拟 GUI 应用启动环境。
    let old_path = std::env::var("PATH").ok();
    let old_home = std::env::var("JAVA_HOME").ok();
    std::env::remove_var("PATH");
    std::env::remove_var("JAVA_HOME");
    let r = decompile::find_java_public();
    // 恢复原始环境变量。
    if let Some(p) = old_path {
        std::env::set_var("PATH", p);
    }
    if let Some(h) = old_home {
        std::env::set_var("JAVA_HOME", h);
    }
    assert!(
        r.is_ok(),
        "find_java should fall back to javac-derived java: {:?}",
        r.err()
    );
}
