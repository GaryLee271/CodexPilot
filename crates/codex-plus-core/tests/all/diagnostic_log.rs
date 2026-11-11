use serde_json::{Value, json};

/// 并发写诊断日志时每条记录各占一行：以前 `writeln!` 分两次写，
/// 别的线程的记录会插到记录和换行之间，两条挤成一行、都解析不了。
#[test]
fn concurrent_diagnostic_records_stay_one_per_line() {
    // 诊断日志路径是进程级状态，与其它测试模块串行。
    let _state = crate::common::global_state_lock();
    let temp = tempfile::tempdir().unwrap();
    let log_path = temp.path().join("codex-plus.log");
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(log_path.clone()));
    let threads: Vec<_> = (0..8)
        .map(|thread| {
            std::thread::spawn(move || {
                for index in 0..200 {
                    codex_plus_core::diagnostic_log::append_diagnostic_log(
                        "test.concurrent_record",
                        json!({ "thread": thread, "index": index, "pad": "x".repeat(200) }),
                    )
                    .unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(None);

    let contents = std::fs::read_to_string(&log_path).unwrap();
    let ours = contents
        .lines()
        .filter(|line| line.contains("test.concurrent_record"))
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .unwrap_or_else(|error| panic!("每行都要是一条完整记录：{error}\n{line}"))
        })
        .count();
    assert_eq!(ours, 8 * 200);
}

/// 模拟日志多次超过容量阈值，验证真实写入路径会裁剪旧记录，且不累积归档。
#[test]
fn append_compacts_oversized_log_and_keeps_latest_records_without_archives() {
    use std::io::{Seek, SeekFrom, Write};

    let _state = crate::common::global_state_lock();
    let temp = tempfile::tempdir().unwrap();
    let log_path = temp.path().join("codex-plus.log");
    const MAX_BYTES: u64 = 50 * 1024 * 1024;
    const KEEP_BYTES: u64 = 5 * 1024 * 1024;

    for round in 0..3 {
        let mut file = std::fs::File::create(&log_path).unwrap();
        file.write_all(b"{\"event\":\"test.discarded\"}\n").unwrap();
        // 稀疏文件模拟长期增长，不必生成 50 MiB 的测试记录。
        file.set_len(MAX_BYTES + 1).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(b"\n{\"event\":\"test.retained\"}\n")
            .unwrap();
        drop(file);

        let previous = codex_plus_core::diagnostic_log::swap_diagnostic_log_path_for_tests(Some(
            log_path.clone(),
        ));
        let result = codex_plus_core::diagnostic_log::append_diagnostic_log(
            "test.after_compaction",
            json!({ "round": round }),
        );
        codex_plus_core::diagnostic_log::swap_diagnostic_log_path_for_tests(previous);
        result.unwrap();

        assert!(std::fs::metadata(&log_path).unwrap().len() <= KEEP_BYTES + 1024);
        let contents = std::fs::read_to_string(&log_path).unwrap();
        let records: Vec<Value> = contents
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["event"], "test.retained");
        assert_eq!(records[1]["event"], "test.after_compaction");
        assert_eq!(records[1]["detail"]["round"], round);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
