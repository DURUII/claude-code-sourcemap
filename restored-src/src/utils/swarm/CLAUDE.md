`swarm/` 是核心，mailbox、teammate 身份、task 状态、UI hooks 在外面。
按关注点分离的：swarm 管调度，mailbox 管通信，task 管状态，hooks 管 UI。